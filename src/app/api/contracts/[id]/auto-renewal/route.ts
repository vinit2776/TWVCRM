import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getCachedSettings } from "@/lib/app-settings-cache";
import {
  AUTO_RENEW_CRON_MODE_SETTING,
  AUTO_RENEW_MANAGE_ROLES,
  AUTO_RENEW_PAUSE_REASON_PREFIX,
  checkRevision,
  parseAutoRenewMode,
  parseAutoRenewTiming,
  programmedEscalation,
} from "@/lib/auto-renewal";
import { planAutoRenewals } from "@/lib/auto-renewal-plan";
import { loadAutoRenewFacts } from "@/lib/auto-renewal-plan-server";
import { stopAutoRenewal } from "@/lib/auto-renewal-server";
import { lockedRateNotice } from "@/lib/auto-renewal-notice-server";

const VIEW_ROLES = ["admin", "manager", "sales_rep", "floor_manager", "accounts"];

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable") }),
  z.object({ action: z.literal("pause"), reason: z.string().trim().min(1, "A reason is required") }),
  z.object({
    action: z.literal("revise"),
    escalation_percentage: z.number().min(0).max(100),
    reason: z.string().trim().min(1, "A reason is required"),
  }),
  z.object({ action: z.literal("clear_revision") }),
]);

const MIGRATION_MISSING = "Auto-renewal is not set up on this database yet (migrations 00662 and 00669 not applied).";

async function actor() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  return dbUser ?? null;
}

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

const CLEARED = {
  auto_renew_escalation_override: null,
  auto_renew_revised_at: null,
  auto_renew_revised_by: null,
  auto_renew_revision_reason: null,
};

/**
 * GET /api/contracts/[id]/auto-renewal: where this contract is on its renewal
 * schedule, for the card on the contract page. Read only.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await actor();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!VIEW_ROLES.includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const today = todayIst();
  const [facts, settings, row] = await Promise.all([
    loadAutoRenewFacts(admin, today, { contractId: id }),
    getCachedSettings(admin, [
      AUTO_RENEW_CRON_MODE_SETTING,
      "auto_renew_draft_lead_days",
      "auto_renew_notice_lead_days",
      "auto_renew_confirmation_days",
    ]),
    admin.from("contracts").select("*").eq("id", id).maybeSingle(),
  ]);
  if (facts === null) return NextResponse.json({ data: null, unavailable: MIGRATION_MISSING });
  if (!row.data) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  const c = row.data as Record<string, unknown>;

  const mode = parseAutoRenewMode(settings[AUTO_RENEW_CRON_MODE_SETTING]);
  const lock = await lockedRateNotice(admin, id, String(c.end_date).slice(0, 10));
  const item = facts[0] ? planAutoRenewals(facts, today, parseAutoRenewTiming(settings)).items[0] : null;

  return NextResponse.json({
    data: {
      autoRenew: !!c.auto_renew,
      mode,
      // The job only reports today: nothing is prepared, sent or rolled. The card has to say so.
      live: false,
      stoppedAt: (c.auto_renew_stopped_at as string | null) ?? null,
      stopReason: (c.auto_renew_stop_reason as string | null) ?? null,
      paused: !c.auto_renew && String(c.auto_renew_stop_reason ?? "").startsWith(AUTO_RENEW_PAUSE_REASON_PREFIX),
      // Set once the rate notice has gone out: the next term's rent is then what the customer was told.
      lock,
      // What the new rent adds to the security deposit. Shown to staff only; it never holds a renewal.
      depositTopUp: item
        ? Math.max(0, Math.round((item.nextRent - Number(c.subtotal ?? 0)) * Number(c.security_deposit_months ?? 3)))
        : 0,
      programmedPct: programmedEscalation(c),
      revised:
        c.auto_renew_escalation_override == null
          ? null
          : {
              percentage: Number(c.auto_renew_escalation_override),
              reason: (c.auto_renew_revision_reason as string | null) ?? null,
              at: (c.auto_renew_revised_at as string | null) ?? null,
            },
      plan: item && {
        stage: item.stage,
        holds: item.holds,
        schedule: item.schedule,
        rollOn: item.rollOn,
        next: item.next,
        nextRent: item.nextRent,
        nextRentPct: item.nextRentPct,
        nextRentIsDraft: item.nextRentIsDraft,
      },
    },
  });
}

/** POST /api/contracts/[id]/auto-renewal: enable, pause, revise the next rate, or clear the revision. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await actor();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(AUTO_RENEW_MANAGE_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only admins, managers and sales reps can change auto-renewal." }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  const body = parsed.data;

  const admin = createAdminClient();
  const { data: contract } = await admin.from("contracts").select("*").eq("id", id).maybeSingle();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (!("auto_renew" in contract) || !("auto_renew_escalation_override" in contract)) {
    return NextResponse.json({ error: MIGRATION_MISSING }, { status: 409 });
  }
  if (!["active", "renewal_in_progress"].includes(contract.status)) {
    return NextResponse.json({ error: `Auto-renewal applies to live contracts. This one is "${contract.status}".` }, { status: 400 });
  }

  if (body.action === "enable") {
    if (contract.renewal_declined) {
      return NextResponse.json({ error: "Renewal was declined for this contract, so it cannot auto-renew." }, { status: 400 });
    }
    const { data: liveExit } = await admin.from("contract_exits").select("id").eq("contract_id", id).eq("status", "in_notice").limit(1);
    if (liveExit && liveExit.length > 0) {
      return NextResponse.json({ error: "This customer has an exit in progress, so it cannot auto-renew." }, { status: 400 });
    }
    const { error } = await admin
      .from("contracts")
      .update({ auto_renew: true, auto_renew_stopped_at: null, auto_renew_stopped_by: null, auto_renew_stop_reason: null })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    logAudit(admin, {
      entityType: "contract", entityId: id, action: "auto_renewal_enabled", performedBy: me.id,
      changes: { auto_renew: { old: !!contract.auto_renew, new: true } },
    });
    return NextResponse.json({ success: true });
  }

  if (body.action === "pause") {
    if (!contract.auto_renew) return NextResponse.json({ error: "Auto-renewal is already off." }, { status: 400 });
    // stopAutoRenewal audits the switch-off itself; the reason carries the pause wording.
    const stopped = await stopAutoRenewal(admin, id, me.id, `${AUTO_RENEW_PAUSE_REASON_PREFIX}: ${body.reason}`);
    if (!stopped) return NextResponse.json({ error: "Could not pause auto-renewal." }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (body.action === "revise" || body.action === "clear_revision") {
    const lock = await lockedRateNotice(admin, id, String(contract.end_date).slice(0, 10));
    if (lock) {
      return NextResponse.json(
        { error: "The customer has already been sent this rate, so it is locked. Agree any change with them directly and renew by hand." },
        { status: 409 },
      );
    }
  }

  if (body.action === "revise") {
    const programmed = programmedEscalation(contract);
    const check = checkRevision(body.escalation_percentage, programmed, me.role);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 403 });
    // Equal to the agreement is no revision at all, so keep nothing.
    const sameAsAgreement = Math.abs(body.escalation_percentage - programmed) < 0.0001;
    const { error } = await admin
      .from("contracts")
      .update(
        sameAsAgreement
          ? CLEARED
          : {
              auto_renew_escalation_override: body.escalation_percentage,
              auto_renew_revised_at: new Date().toISOString(),
              auto_renew_revised_by: me.id,
              auto_renew_revision_reason: body.reason,
            },
      )
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    logAudit(admin, {
      entityType: "contract", entityId: id, action: "auto_renewal_revised", performedBy: me.id,
      changes: {
        auto_renew_escalation_override: {
          old: contract.auto_renew_escalation_override ?? null,
          new: sameAsAgreement ? null : body.escalation_percentage,
        },
        reason: { old: null, new: body.reason },
      },
    });
    return NextResponse.json({ success: true });
  }

  const { error } = await admin.from("contracts").update(CLEARED).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(admin, {
    entityType: "contract", entityId: id, action: "auto_renewal_revised", performedBy: me.id,
    changes: { auto_renew_escalation_override: { old: contract.auto_renew_escalation_override ?? null, new: null } },
  });
  return NextResponse.json({ success: true });
}

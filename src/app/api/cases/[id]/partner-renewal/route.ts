import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { rollPartnerRenewal } from "@/lib/vo-partner-renewal";
import {
  partnerRenewalOffer,
  partnerRenewalRecord,
  type PartnerRenewalRecord,
} from "@/lib/vo-renewal-reminders";
import { RENEWAL_DURATIONS, RENEWAL_ESCALATION_MODES } from "@/lib/vo-renewal-offer";

/**
 * Postpaid partner cases have no renewal bill: the partner is invoiced monthly
 * for all their cases, so there is nothing to send or collect at renewal. What
 * staff do instead is confirm with the partner that the case continues.
 *
 * GET     the recorded confirmation for this case, if any.
 * POST    action "confirm"  record that the partner is continuing, with the
 *                           term, the monthly fee from that term and how they
 *                           confirmed. Rolls the case straight over if the new
 *                           term has already begun.
 *         action "roll"     roll a confirmed case into its new term (allowed
 *                           from the new term's first day).
 * DELETE  withdraw a recorded confirmation.
 *
 * Sends nothing to anyone. Person-driven, so the cron's opt-in
 * (renewal_notices_enabled) is not checked here.
 */

const ALLOWED_ROLES = ["admin", "manager", "sales_rep"];
const OPEN_STATUSES = ["active", "renewal_due", "grace_period"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const confirmSchema = z
  .object({
    action: z.literal("confirm"),
    duration_months: z
      .number()
      .int()
      .refine((n) => (RENEWAL_DURATIONS as readonly number[]).includes(n), "Choose 6, 12, 24 or 36 months"),
    escalation_mode: z.enum(RENEWAL_ESCALATION_MODES),
    custom_percentage: z.number().min(0).max(100).nullish(),
    escalation_reason: z.string().trim().max(500).nullish(),
    /** The end date and monthly fee they saw, so a stale dialog can't confirm other terms. */
    confirm_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expected_rate: z.number().nonnegative(),
    note: z.string().trim().min(10, "Say how the partner confirmed (at least 10 characters)").max(1000),
  })
  .refine((b) => b.escalation_mode !== "custom" || (b.custom_percentage ?? 0) > 0, {
    message: "Enter the custom escalation percentage",
    path: ["custom_percentage"],
  })
  .refine((b) => b.escalation_mode !== "custom" || (b.escalation_reason ?? "").length >= 10, {
    message: "Give a reason of at least 10 characters for a custom escalation",
    path: ["escalation_reason"],
  });

const rollSchema = z.object({ action: z.literal("roll") });

function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

async function authorise() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { supabase, dbUser: dbUser as { id: string; role: string; full_name: string | null } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPartnerCase(admin: any, id: string) {
  const { data } = await admin
    .from("cases")
    .select("id, case_number, status, end_date, rate, renewal_escalation_percentage, aggregator_id, metadata, aggregator:aggregators!cases_aggregator_id_fkey(billing_method)")
    .eq("id", id)
    .maybeSingle();
  return data as
    | {
        id: string;
        case_number: string;
        status: string;
        end_date: string | null;
        rate: number;
        renewal_escalation_percentage: number | null;
        aggregator_id: string | null;
        metadata: unknown;
        aggregator: { billing_method: string } | { billing_method: string }[] | null;
      }
    | null;
}

function isPostpaid(c: NonNullable<Awaited<ReturnType<typeof loadPartnerCase>>>): boolean {
  const agg = Array.isArray(c.aggregator) ? c.aggregator[0] : c.aggregator;
  return !!c.aggregator_id && agg?.billing_method === "postpaid";
}

function metadataOf(c: { metadata: unknown }): Record<string, unknown> {
  return c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata)
    ? (c.metadata as Record<string, unknown>)
    : {};
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;

  const admin = await createAdminClient();
  const c = await loadPartnerCase(admin, id);
  if (!c) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  return NextResponse.json({
    data: { postpaid: isPostpaid(c), confirmation: partnerRenewalRecord(c.metadata), today: todayIst() },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;
  const { supabase, dbUser } = auth;
  if (!ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to renew partner cases" }, { status: 403 });
  }

  const raw = await request.json().catch(() => ({}));
  const admin = await createAdminClient();
  const c = await loadPartnerCase(admin, id);
  if (!c) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  if (!isPostpaid(c)) {
    return NextResponse.json(
      { error: "Only a case billed monthly to a postpaid partner is continued without a bill." },
      { status: 400 },
    );
  }
  if (!c.end_date) {
    return NextResponse.json({ error: "This case has no end date, so there is no term to renew." }, { status: 400 });
  }
  if (!OPEN_STATUSES.includes(c.status)) {
    return NextResponse.json({ error: `A ${c.status.replace(/_/g, " ")} case can't be renewed from here.` }, { status: 400 });
  }

  const today = todayIst();

  // ---- roll --------------------------------------------------------------
  if (rollSchema.safeParse(raw).success) {
    const result = await rollPartnerRenewal(admin, { caseId: id, performedBy: dbUser.id, today });
    if (result.outcome === "renewed") {
      return NextResponse.json({ data: { rolled: true, successorId: result.successorId } });
    }
    if (result.outcome === "already_renewed") {
      return NextResponse.json({ error: "This case has already been renewed." }, { status: 409 });
    }
    return NextResponse.json({ error: result.message }, { status: 400 });
  }

  // ---- confirm -----------------------------------------------------------
  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const body = parsed.data;
  if (!(Number(c.rate) > 0)) {
    return NextResponse.json({ error: "This case has no monthly fee on record. Set its rate first." }, { status: 400 });
  }

  const offer = partnerRenewalOffer({
    currentMonthlyRate: Number(c.rate),
    agreedEscalationPercentage: c.renewal_escalation_percentage,
    currentEnd: c.end_date,
    durationMonths: body.duration_months,
    mode: body.escalation_mode,
    customPercentage: body.custom_percentage,
  });
  if (c.end_date !== body.confirm_end_date || Math.abs(offer.newRate - body.expected_rate) > 0.005) {
    return NextResponse.json(
      { error: "The case changed while this was open. Close the dialog and start again." },
      { status: 409 },
    );
  }

  const existing = partnerRenewalRecord(c.metadata);
  const record: PartnerRenewalRecord = {
    term_start: offer.term.start,
    term_end: offer.term.end,
    duration_months: offer.durationMonths,
    escalation_mode: body.escalation_mode,
    escalation_percentage: offer.escalationPercentage,
    escalation_reason: body.escalation_reason || null,
    current_rate: Number(c.rate),
    new_rate: offer.newRate,
    note: body.note,
    by: dbUser.id,
    by_name: dbUser.full_name,
    at: new Date().toISOString(),
  };

  // Conditional on the metadata read above, so two people confirming at once
  // can't silently overwrite each other.
  const { data: updated, error } = await admin
    .from("cases")
    .update({ metadata: { ...metadataOf(c), partner_renewal: record } })
    .eq("id", id)
    .eq("status", c.status)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "The case changed while you were confirming. Reload and try again." }, { status: 409 });
  }

  logAudit(supabase, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "partner_renewal_confirmed" },
      partner_renewal: { old: existing, new: record },
    },
  });

  // The new term has already begun (the partner confirmed late): nothing to wait for.
  if (today >= record.term_start) {
    const result = await rollPartnerRenewal(admin, { caseId: id, performedBy: dbUser.id, today });
    if (result.outcome === "renewed") {
      return NextResponse.json({ data: { confirmed: true, rolled: true, successorId: result.successorId, record } });
    }
    if (result.outcome !== "already_renewed") {
      return NextResponse.json({ data: { confirmed: true, rolled: false, record, warning: result.message } });
    }
  }
  return NextResponse.json({ data: { confirmed: true, rolled: false, record } });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;
  const { supabase, dbUser } = auth;
  if (!ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to renew partner cases" }, { status: 403 });
  }

  const admin = await createAdminClient();
  const c = await loadPartnerCase(admin, id);
  if (!c) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const existing = partnerRenewalRecord(c.metadata);
  if (!existing) return NextResponse.json({ error: "There is no confirmation to withdraw." }, { status: 400 });

  const next = { ...metadataOf(c) };
  delete next.partner_renewal;
  const { data: updated, error } = await admin
    .from("cases")
    .update({ metadata: next })
    .eq("id", id)
    .eq("status", c.status)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "The case changed. Reload and try again." }, { status: 409 });
  }

  logAudit(supabase, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "partner_renewal_withdrawn" },
      partner_renewal: { old: existing, new: null },
    },
  });
  return NextResponse.json({ data: { withdrawn: true } });
}

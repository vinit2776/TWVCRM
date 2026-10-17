import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  EXIT_COMPLETE_ROLES, EXIT_CHARGE_ROLES, EXIT_START_ROLES, isEarlyExit, validateExitDates,
} from "@/lib/contract-exit";
import { getLiveExit, loadExitView, notifyAllUsers } from "@/lib/contract-exit-server";

const VIEW_ROLES = ["admin", "manager", "sales_rep", "floor_manager", "accounts"];
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");

const startSchema = z.object({
  notice_received_on: ymd,
  last_day: ymd,
  reason: z.string().trim().min(1, "A reason is required"),
});

const patchSchema = z.object({
  notice_received_on: ymd.optional(),
  last_day: ymd.optional(),
  reason: z.string().trim().min(1).optional(),
  inspection_done: z.boolean().optional(),
  cancel: z.boolean().optional(),
  cancel_reason: z.string().trim().optional(),
});

async function actor() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  return dbUser ?? null;
}

/** GET /api/contracts/[id]/exit — the live exit with charges and the settlement preview. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await actor();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!VIEW_ROLES.includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const view = await loadExitView(createAdminClient(), id);
  return NextResponse.json({ data: view });
}

/**
 * POST /api/contracts/[id]/exit — record the customer's notice and start the exit.
 * Nothing is sent to the customer. Every active CRM user gets an internal notice.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await actor();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(EXIT_START_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only admins, managers and sales reps can start an exit." }, { status: 403 });
  }

  const parsed = startSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  const { notice_received_on, last_day, reason } = parsed.data;
  const dates = validateExitDates(notice_received_on, last_day);
  if (!dates.ok) return NextResponse.json({ error: dates.error }, { status: 400 });

  const admin = createAdminClient();
  const { data: contract } = await admin
    .from("contracts")
    .select("id, contract_number, status, end_date, seats, lead:leads!contracts_lead_id_fkey(first_name, last_name, company), location:locations!contracts_location_id_fkey(name)")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (!["active", "renewal_in_progress"].includes(contract.status)) {
    return NextResponse.json({ error: `An exit can only be started on a live contract. This one is "${contract.status}".` }, { status: 400 });
  }
  if (await getLiveExit(admin, id)) {
    return NextResponse.json({ error: "This contract already has an exit in progress." }, { status: 409 });
  }

  const early = isEarlyExit(last_day, contract.end_date as string | null);
  const { data: row, error } = await admin
    .from("contract_exits")
    .insert({ contract_id: id, notice_received_on, last_day, reason, is_early_exit: early, started_by: me.id })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "23505" ? 409 : 500 });

  logAudit(admin, {
    entityType: "contract", entityId: id, action: "exit_started", performedBy: me.id,
    changes: { notice_received_on: { old: null, new: notice_received_on }, last_day: { old: null, new: last_day }, reason: { old: null, new: reason }, early_exit: { old: null, new: early } },
  });

  const lead = contract.lead as unknown as { first_name: string | null; last_name: string | null; company: string | null } | null;
  const customer = lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || "Customer";
  const location = (contract.location as unknown as { name: string } | null)?.name;
  await notifyAllUsers(admin, {
    title: `Exit notice: ${customer} (${contract.contract_number})`,
    body: `${location ? `${location} · ` : ""}${contract.seats ?? 0} seat${contract.seats === 1 ? "" : "s"} · last day ${new Date(`${last_day}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })} · recorded by ${me.full_name ?? "staff"}`,
    url: `/contracts/${id}/exit`,
    contractId: id,
  });

  return NextResponse.json({ data: { id: row.id } }, { status: 201 });
}

/** PATCH /api/contracts/[id]/exit — edit notice, mark inspection done, or cancel. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await actor();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  const body = parsed.data;

  const admin = createAdminClient();
  const exit = await getLiveExit(admin, id);
  if (!exit) return NextResponse.json({ error: "No exit in progress for this contract." }, { status: 404 });

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  let action: "exit_updated" | "exit_cancelled" = "exit_updated";

  if (body.cancel) {
    if (!(EXIT_COMPLETE_ROLES as readonly string[]).includes(me.role)) {
      return NextResponse.json({ error: "Only admins and managers can cancel an exit." }, { status: 403 });
    }
    if (exit.status !== "in_notice") return NextResponse.json({ error: "A completed exit can't be cancelled." }, { status: 400 });
    if (!body.cancel_reason) return NextResponse.json({ error: "A reason is required to cancel." }, { status: 400 });
    update.status = "cancelled";
    update.cancelled_at = new Date().toISOString();
    update.cancelled_by = me.id;
    update.cancel_reason = body.cancel_reason;
    changes.status = { old: exit.status, new: "cancelled" };
    changes.cancel_reason = { old: null, new: body.cancel_reason };
    action = "exit_cancelled";
  } else {
    const wantsDates = body.notice_received_on !== undefined || body.last_day !== undefined || body.reason !== undefined;
    if (wantsDates) {
      if (!(EXIT_START_ROLES as readonly string[]).includes(me.role)) {
        return NextResponse.json({ error: "Only admins, managers and sales reps can edit the notice." }, { status: 403 });
      }
      if (exit.status !== "in_notice") return NextResponse.json({ error: "The notice can't be edited after the exit is completed." }, { status: 400 });
      const notice = body.notice_received_on ?? exit.notice_received_on;
      const last = body.last_day ?? exit.last_day;
      const dates = validateExitDates(notice, last);
      if (!dates.ok) return NextResponse.json({ error: dates.error }, { status: 400 });
      if (notice !== exit.notice_received_on) { update.notice_received_on = notice; changes.notice_received_on = { old: exit.notice_received_on, new: notice }; }
      if (last !== exit.last_day) {
        const { data: c } = await admin.from("contracts").select("end_date").eq("id", id).single();
        update.last_day = last;
        update.is_early_exit = isEarlyExit(last, (c?.end_date as string | null) ?? null);
        changes.last_day = { old: exit.last_day, new: last };
      }
      if (body.reason !== undefined && body.reason !== exit.reason) { update.reason = body.reason; changes.reason = { old: exit.reason, new: body.reason }; }
    }
    if (body.inspection_done !== undefined) {
      if (!(EXIT_CHARGE_ROLES as readonly string[]).includes(me.role)) {
        return NextResponse.json({ error: "You can't mark the inspection done." }, { status: 403 });
      }
      update.inspection_done_at = body.inspection_done ? new Date().toISOString() : null;
      update.inspection_done_by = body.inspection_done ? me.id : null;
      changes.inspection_done = { old: !!exit.inspection_done_at, new: body.inspection_done };
    }
  }

  if (Object.keys(changes).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  const { error } = await admin.from("contract_exits").update(update).eq("id", exit.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(admin, { entityType: "contract", entityId: id, action, performedBy: me.id, changes });
  return NextResponse.json({ ok: true });
}

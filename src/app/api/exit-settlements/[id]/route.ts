import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { SETTLEMENT_VIEW_ROLES } from "@/lib/exit-settlement";
import { customerLabel, normalizeSettlement } from "@/lib/exit-settlement-server";

/**
 * GET /api/exit-settlements/[id] — the settlement with everything the approver
 * needs to check every step: the exit, the timeline of who did what, the charges
 * as they were when cleared, and a checklist.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!me || !(SETTLEMENT_VIEW_ROLES as readonly string[]).includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const { data: raw } = await admin
    .from("exit_settlements")
    .select("*, cleared_user:users!exit_settlements_cleared_by_fkey(full_name), approved_user:users!exit_settlements_approved_by_fkey(full_name), returned_user:users!exit_settlements_returned_by_fkey(full_name), paid_user:users!exit_settlements_paid_by_fkey(full_name)")
    .eq("id", id).single();
  if (!raw) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { cleared_user, approved_user, returned_user, paid_user, ...rest } = raw as Record<string, unknown> & {
    cleared_user?: { full_name: string | null } | null; approved_user?: { full_name: string | null } | null;
    returned_user?: { full_name: string | null } | null; paid_user?: { full_name: string | null } | null;
  };
  const settlement = normalizeSettlement(rest);

  const [{ data: exit }, { data: contract }, { data: audit }] = await Promise.all([
    admin.from("contract_exits").select("*, started_user:users!contract_exits_started_by_fkey(full_name), completed_user:users!contract_exits_completed_by_fkey(full_name), inspection_user:users!contract_exits_inspection_done_by_fkey(full_name)").eq("id", settlement.exit_id).single(),
    admin.from("contracts").select("contract_number, end_date, seats, lock_in_months, lead:leads!contracts_lead_id_fkey(first_name, last_name, company), location:locations!contracts_location_id_fkey(name)").eq("id", settlement.contract_id).single(),
    admin.from("audit_trail").select("action, changes, created_at, performer:users!audit_trail_performed_by_fkey(full_name)")
      .eq("entity_type", "contract").eq("entity_id", settlement.contract_id).like("action", "exit_%").order("created_at", { ascending: true }),
  ]);

  const e = exit as unknown as (Record<string, unknown> & { started_user?: { full_name: string | null } | null; completed_user?: { full_name: string | null } | null; inspection_user?: { full_name: string | null } | null }) | null;
  const c = contract as unknown as { contract_number: string; end_date: string | null; seats: number | null; lead: { first_name: string | null; last_name: string | null; company: string | null } | null; location: { name: string } | null } | null;
  const charges = settlement.snapshot.charges ?? [];

  const checks = [
    { ok: !!e, label: `Notice recorded${e ? ` ${e.notice_received_on}, last day ${e.last_day}` : ""}` },
    { ok: e?.status === "completed", label: e?.status === "completed" ? `Exit completed ${String(e?.completed_at ?? "").slice(0, 10)} by ${e?.completed_user?.full_name ?? "staff"}` : "Exit not completed" },
    { ok: !!e?.inspection_done_at, label: e?.inspection_done_at ? `Inspection marked done by ${e?.inspection_user?.full_name ?? "staff"}` : "Inspection not marked done" },
    { ok: settlement.retained_amount + settlement.refund_amount <= settlement.deposit_amount + 0.01, label: "Refund plus retained charges do not exceed the deposit available" },
    ...(e?.is_early_exit ? [{ ok: true, warn: true, label: "Early exit: before the contract end date (no penalty applied)" }] : []),
    ...(charges.some((x) => x.edited_after_add) ? [{ ok: true, warn: true, label: `${charges.filter((x) => x.edited_after_add).length} charge(s) edited after being added` }] : []),
  ];

  return NextResponse.json({
    data: {
      settlement: {
        ...settlement,
        bank_account_number_masked: settlement.bank_account_number ? `••••${settlement.bank_account_number.slice(-4)}` : null,
        cleared_by_name: cleared_user?.full_name ?? null, approved_by_name: approved_user?.full_name ?? null,
        returned_by_name: returned_user?.full_name ?? null, paid_by_name: paid_user?.full_name ?? null,
      },
      exit: e ? { id: e.id, status: e.status, notice_received_on: e.notice_received_on, last_day: e.last_day, reason: e.reason, is_early_exit: e.is_early_exit, started_by_name: e.started_user?.full_name ?? null } : null,
      contract: c ? { id: settlement.contract_id, contract_number: c.contract_number, customer: customerLabel(c.lead), location: c.location?.name ?? null, seats: c.seats, end_date: c.end_date } : null,
      timeline: [
        ...(audit ?? []).map((a) => ({ action: a.action as string, changes: a.changes as Record<string, { old: unknown; new: unknown }>, at: a.created_at as string, by: (a.performer as unknown as { full_name: string | null } | null)?.full_name ?? null })),
        // Completing an exit goes through the contract terminate path, which has its own audit entry; show it here.
        ...(e?.completed_at ? [{ action: "exit_completed", changes: {}, at: e.completed_at as string, by: e.completed_user?.full_name ?? null }] : []),
      ].sort((x, y) => x.at.localeCompare(y.at)),
      checks,
      self_cleared: !!settlement.cleared_by && settlement.cleared_by === settlement.approved_by,
    },
  });
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";

/**
 * Rent waivers (migration 00575) — an admin records that a missed rent month
 * won't be billed through the CRM. Shared by the single-month route and the
 * bulk "Waive all" route so both apply exactly the same checks.
 */
export type WaiveResult =
  | { ok: true; waiver: { id: string; waived_month: string; reason: string; waived_at: string } }
  | { ok: false; status: number; error: string };

export async function createRentWaiver(
  admin: SupabaseClient,
  opts: { contractId: string; waivedMonth: string; reason: string; userId: string },
): Promise<WaiveResult> {
  const { contractId, waivedMonth, reason, userId } = opts;

  const { data: contract } = await admin
    .from("contracts").select("id, start_date").eq("id", contractId).maybeSingle();
  if (!contract) return { ok: false, status: 404, error: "Contract not found" };

  // Only months that can actually be gaps: not before the contract's first
  // month, and not after the current month (future months aren't owed yet).
  const currentMonthFirst = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 7) + "-01";
  if (waivedMonth < `${String(contract.start_date).slice(0, 7)}-01` || waivedMonth > currentMonthFirst) {
    return { ok: false, status: 422, error: "Only a past or current month within the contract can be waived" };
  }

  // A month that already has a rent statement isn't a gap — void/discard that instead.
  const [y, m] = waivedMonth.split("-").map(Number);
  const { data: covering } = await admin
    .from("billing_statements")
    .select("id")
    .eq("contract_id", contractId)
    .in("statement_type", ["rent", "combined"])
    .eq("prepaid_year", y)
    .eq("prepaid_month", m)
    .is("voided_at", null)
    .neq("status", "discarded")
    .limit(1);
  if ((covering ?? []).length > 0) {
    return { ok: false, status: 409, error: "This month already has a rent statement — nothing to waive" };
  }

  const { data: waiver, error } = await admin
    .from("contract_rent_waivers")
    .insert({ contract_id: contractId, waived_month: waivedMonth, reason, waived_by: userId })
    .select("id, waived_month, reason, waived_at")
    .single();

  if (error || !waiver) {
    // 23505 = the live-waiver unique index: this month is already waived.
    if (error?.code === "23505") return { ok: false, status: 409, error: "This month is already waived" };
    return { ok: false, status: 500, error: error?.message ?? "Insert failed" };
  }

  logAudit(admin, {
    entityType: "contract",
    entityId: contractId,
    action: "rent_month_waived",
    performedBy: userId,
    changes: { waived_month: { old: null, new: waivedMonth }, reason: { old: null, new: reason } },
  });

  return { ok: true, waiver };
}

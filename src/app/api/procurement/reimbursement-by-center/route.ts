import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/procurement/reimbursement-by-center?year=&month=
 *
 * View-only breakdown of this month's committed reimbursement spend by
 * center. Reimbursement is billed back to the customer's contract, not drawn
 * from any department's budget — see the explicit bypass in
 * requests/[id]/route.ts's approval gate — so this is visibility only, with
 * no cap and no enforcement. The center comes from the linked contract's own
 * location (billable_contract_id -> contracts.location_id), not a
 * separately-picked field, since the contract's location is already the
 * source of truth and asking for it twice risks the two disagreeing.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const year = parseInt(searchParams.get("year") ?? String(new Date().getFullYear()));
  const month = parseInt(searchParams.get("month") ?? String(new Date().getMonth() + 1));
  const monthStart = new Date(year, month - 1, 1).toISOString();
  const monthEnd = new Date(year, month, 0, 23, 59, 59).toISOString();

  const { data: mrs, error } = await supabase
    .from("purchase_requests")
    .select(
      "total_estimated_amount, billable_contract:contracts!billable_contract_id(location_id, location:locations!contracts_location_id_fkey(id, name))"
    )
    .eq("department", "reimbursement")
    .eq("expenditure_type", "operational")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .in("status", ["approved", "partially_ordered", "po_created"]);
  if (error) console.error("[reimbursement-by-center] query failed:", error.message);

  type Row = {
    total_estimated_amount: number | null;
    billable_contract: { location_id: string | null; location: { id: string; name: string } | null } | null;
  };

  const byCenter = new Map<string, { location_id: string; location_name: string; spent_this_month: number; mr_count: number }>();
  let unattributed = 0;

  for (const mr of (mrs ?? []) as unknown as Row[]) {
    const amount = Number(mr.total_estimated_amount ?? 0);
    const location = mr.billable_contract?.location;
    if (!location) {
      unattributed += amount;
      continue;
    }
    const existing = byCenter.get(location.id);
    if (existing) {
      existing.spent_this_month += amount;
      existing.mr_count += 1;
    } else {
      byCenter.set(location.id, { location_id: location.id, location_name: location.name, spent_this_month: amount, mr_count: 1 });
    }
  }

  const centers = Array.from(byCenter.values()).sort((a, b) => b.spent_this_month - a.spent_this_month);
  const total = centers.reduce((s, c) => s + c.spent_this_month, 0) + unattributed;

  return NextResponse.json({ data: { centers, unattributed_spend_this_month: unattributed, total_this_month: total, year, month } });
}

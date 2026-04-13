import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

  // ── Parallel queries ──────────────────────────────────────────────────────
  const [
    mrPendingRes,
    mrApprovedRes,
    mrByDeptRes,
    mrThisMonthRes,
    openPoRes,
    poThisMonthRes,
    poByStatusRes,
    billsPendingRes,
    recentMrsRes,
    recentPosRes,
    topVendorsRes,
  ] = await Promise.all([
    // MRs pending approval (submitted)
    supabase
      .from("purchase_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted"),

    // MRs approved but not yet fully ordered
    supabase
      .from("purchase_requests")
      .select("id, total_estimated_amount", { count: "exact" })
      .in("status", ["approved", "partially_ordered"]),

    // MRs created this month, grouped by department
    supabase
      .from("purchase_requests")
      .select("department")
      .gte("created_at", monthStart),

    // Total MRs this month
    supabase
      .from("purchase_requests")
      .select("id", { count: "exact", head: true })
      .gte("created_at", monthStart),

    // Open POs (pending + ordered)
    supabase
      .from("purchase_orders")
      .select("id, total_ordered_amount", { count: "exact" })
      .in("status", ["pending", "ordered"]),

    // PO spend this month (ordered/received/invoiced)
    supabase
      .from("purchase_orders")
      .select("total_ordered_amount")
      .gte("created_at", monthStart)
      .not("status", "eq", "cancelled"),

    // POs by status (all time, non-cancelled for summary)
    supabase
      .from("purchase_orders")
      .select("status")
      .not("status", "eq", "cancelled"),

    // Vendor bills pending approval
    supabase
      .from("vendor_bills")
      .select("id, bill_amount", { count: "exact" })
      .eq("status", "pending"),

    // Recent 5 MRs
    supabase
      .from("purchase_requests")
      .select("id, pr_number, department, status, total_estimated_amount, created_at, requester:users!purchase_requests_requested_by_fkey(full_name)")
      .order("created_at", { ascending: false })
      .limit(5),

    // Recent 5 POs
    supabase
      .from("purchase_orders")
      .select("id, po_number, status, total_ordered_amount, created_at, procurement_vendors(name)")
      .order("created_at", { ascending: false })
      .limit(5),

    // Top 5 vendors by PO value this month
    supabase
      .from("purchase_orders")
      .select("vendor_id, total_ordered_amount, procurement_vendors(name)")
      .gte("created_at", monthStart)
      .not("status", "eq", "cancelled"),
  ]);

  // ── Compute aggregates ────────────────────────────────────────────────────

  // Approved MRs: sum of estimated amounts
  const approvedMrValue = (mrApprovedRes.data ?? []).reduce(
    (sum: number, r: { total_estimated_amount?: number | null }) => sum + (r.total_estimated_amount ?? 0), 0
  );

  // MRs by department this month
  const deptCounts: Record<string, number> = {};
  for (const r of mrByDeptRes.data ?? []) {
    const d = (r as { department: string }).department;
    deptCounts[d] = (deptCounts[d] ?? 0) + 1;
  }

  // Open PO value
  const openPoValue = (openPoRes.data ?? []).reduce(
    (sum: number, r: { total_ordered_amount?: number | null }) => sum + (r.total_ordered_amount ?? 0), 0
  );

  // Spend this month
  const spendThisMonth = (poThisMonthRes.data ?? []).reduce(
    (sum: number, r: { total_ordered_amount?: number | null }) => sum + (r.total_ordered_amount ?? 0), 0
  );

  // POs by status breakdown
  const poStatusCounts: Record<string, number> = {};
  for (const r of poByStatusRes.data ?? []) {
    const s = (r as { status: string }).status;
    poStatusCounts[s] = (poStatusCounts[s] ?? 0) + 1;
  }

  // Bills pending value
  const billsPendingValue = (billsPendingRes.data ?? []).reduce(
    (sum: number, r: { bill_amount?: number | null }) => sum + (r.bill_amount ?? 0), 0
  );

  // Top vendors by spend this month
  const vendorSpend: Record<string, { name: string; amount: number }> = {};
  for (const r of topVendorsRes.data ?? []) {
    const row = r as unknown as { vendor_id: string; total_ordered_amount?: number | null; procurement_vendors?: { name: string } | null };
    if (!row.vendor_id) continue;
    const name = row.procurement_vendors?.name ?? "Unknown";
    if (!vendorSpend[row.vendor_id]) vendorSpend[row.vendor_id] = { name, amount: 0 };
    vendorSpend[row.vendor_id].amount += row.total_ordered_amount ?? 0;
  }
  const topVendors = Object.values(vendorSpend)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return NextResponse.json({
    data: {
      // KPI cards
      mrPendingApproval:  mrPendingRes.count ?? 0,
      mrApprovedCount:    mrApprovedRes.count ?? 0,
      mrApprovedValue: approvedMrValue,
      mrThisMonth:        mrThisMonthRes.count ?? 0,
      openPoCount:        openPoRes.count ?? 0,
      openPoValue,
      spendThisMonth,
      billsPendingCount:  billsPendingRes.count ?? 0,
      billsPendingValue,
      // Breakdowns
      mrByDepartment:     deptCounts,
      poByStatus:         poStatusCounts,
      topVendors,
      // Recent activity
      recentMrs: recentMrsRes.data ?? [],
      recentPos: recentPosRes.data ?? [],
    },
  });
}

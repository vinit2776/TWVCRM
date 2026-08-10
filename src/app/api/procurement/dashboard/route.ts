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
  const todayStr = now.toISOString().split("T")[0];
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // ── Parallel queries ──────────────────────────────────────────────────────
  const [
    mrPendingRes,
    mrApprovedRes,
    mrByDeptRes,
    mrThisMonthRes,
    openPoRes,
    poThisMonthRes,
    poByStatusRes,
    // ── Bills intelligence: unpaid approved bills (payment pipeline) ──
    billsPaymentPipelineRes,
    // ── Bills intelligence: awaiting approval ──
    billsAwaitingApprovalRes,
    // ── MR approval pipeline: the actual submitted MRs with detail ──
    mrApprovalPipelineRes,
    recentMrsRes,
    recentPosRes,
    topVendorsRes,
  ] = await Promise.all([
    // MRs pending approval count
    supabase
      .from("purchase_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted"),

    // MRs approved but not yet fully ordered
    supabase
      .from("purchase_requests")
      .select("id, total_estimated_amount", { count: "exact" })
      .in("status", ["approved", "partially_ordered"]),

    // MRs created this month by department
    supabase
      .from("purchase_requests")
      .select("department")
      .gte("created_at", monthStart),

    // Total MRs this month
    supabase
      .from("purchase_requests")
      .select("id", { count: "exact", head: true })
      .gte("created_at", monthStart),

    // Open POs
    supabase
      .from("purchase_orders")
      .select("id, total_ordered_amount", { count: "exact" })
      .in("status", ["pending", "ordered"]),

    // MRs approved this month → "Spent This Month"
    supabase
      .from("purchase_requests")
      .select("total_estimated_amount")
      .in("status", ["approved", "partially_ordered", "po_created"])
      .gte("approved_at", monthStart),

    // POs by status
    supabase
      .from("purchase_orders")
      .select("status")
      .not("status", "eq", "cancelled"),

    // Payment pipeline: approved bills that are unpaid or partially paid
    // Ordered by due_date ascending so most urgent appear first
    supabase
      .from("vendor_bills")
      .select(`
        id, bill_number, total_amount, amount_paid, due_date, payment_status,
        invoice_date, created_at,
        procurement_vendors(id, name),
        purchase_orders(id, po_number)
      `)
      .eq("approval_status", "approved")
      .in("payment_status", ["unpaid", "partially_paid"])
      .order("due_date", { ascending: true, nullsFirst: false }),

    // Awaiting approval: bills submitted but not yet approved/rejected
    supabase
      .from("vendor_bills")
      .select(`
        id, bill_number, total_amount, amount_paid, due_date, invoice_date, created_at,
        procurement_vendors(id, name),
        purchase_orders(id, po_number)
      `)
      .eq("approval_status", "pending")
      .order("created_at", { ascending: true }),

    // MR approval pipeline: submitted MRs with detail, oldest first (most urgent)
    supabase
      .from("purchase_requests")
      .select(`
        id, pr_number, department, total_estimated_amount, created_at, notes,
        requester:users!purchase_requests_requested_by_fkey(id, full_name),
        purchase_request_items(id, item_name, quantity, unit, estimated_price)
      `)
      .eq("status", "submitted")
      .order("created_at", { ascending: true }),

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

  const approvedMrValue = (mrApprovedRes.data ?? []).reduce(
    (sum: number, r: { total_estimated_amount?: number | null }) => sum + (r.total_estimated_amount ?? 0), 0
  );

  const deptCounts: Record<string, number> = {};
  for (const r of mrByDeptRes.data ?? []) {
    const d = (r as { department: string }).department;
    deptCounts[d] = (deptCounts[d] ?? 0) + 1;
  }

  const openPoValue = (openPoRes.data ?? []).reduce(
    (sum: number, r: { total_ordered_amount?: number | null }) => sum + (r.total_ordered_amount ?? 0), 0
  );

  if (poThisMonthRes.error) console.error("[procurement dashboard] spend-this-month query failed:", poThisMonthRes.error.message);
  const spendThisMonth = (poThisMonthRes.data ?? []).reduce(
    (sum: number, r: { total_estimated_amount?: number | null }) => sum + (r.total_estimated_amount ?? 0), 0
  );

  const poStatusCounts: Record<string, number> = {};
  for (const r of poByStatusRes.data ?? []) {
    const s = (r as { status: string }).status;
    poStatusCounts[s] = (poStatusCounts[s] ?? 0) + 1;
  }

  // Payment pipeline totals
  const paymentPipeline = billsPaymentPipelineRes.data ?? [];
  const billsPaymentTotal = paymentPipeline.reduce(
    (sum: number, r: { total_amount?: number | null; amount_paid?: number | null }) =>
      sum + ((r.total_amount ?? 0) - (r.amount_paid ?? 0)), 0
  );
  const billsOverdueCount = paymentPipeline.filter(
    (b: { due_date?: string | null }) => b.due_date && b.due_date < todayStr
  ).length;

  // Awaiting approval totals
  const awaitingApproval = billsAwaitingApprovalRes.data ?? [];
  const billsAwaitingTotal = awaitingApproval.reduce(
    (sum: number, r: { total_amount?: number | null }) => sum + (r.total_amount ?? 0), 0
  );

  // MR approval pipeline
  const mrPipeline = mrApprovalPipelineRes.data ?? [];
  const mrPipelineValue = mrPipeline.reduce(
    (sum: number, r: { total_estimated_amount?: number | null }) => sum + (r.total_estimated_amount ?? 0), 0
  );

  // Top vendors
  const vendorSpend: Record<string, { id: string; name: string; amount: number }> = {};
  for (const r of topVendorsRes.data ?? []) {
    const row = r as unknown as { vendor_id: string; total_ordered_amount?: number | null; procurement_vendors?: { name: string } | null };
    if (!row.vendor_id) continue;
    const name = row.procurement_vendors?.name ?? "Unknown";
    if (!vendorSpend[row.vendor_id]) vendorSpend[row.vendor_id] = { id: row.vendor_id, name, amount: 0 };
    vendorSpend[row.vendor_id].amount += row.total_ordered_amount ?? 0;
  }
  const topVendors = Object.values(vendorSpend).sort((a, b) => b.amount - a.amount).slice(0, 5);

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
      // Bills (kept for legacy KPI card)
      billsPendingCount:  awaitingApproval.length,
      billsPendingValue:  billsAwaitingTotal,
      // Breakdowns
      mrByDepartment: deptCounts,
      poByStatus:     poStatusCounts,
      topVendors,
      // Recent activity
      recentMrs: recentMrsRes.data ?? [],
      recentPos: recentPosRes.data ?? [],
      // ── Intelligence panels ──
      billsPaymentPipeline: paymentPipeline,
      billsPaymentTotal,
      billsOverdueCount,
      billsAwaitingApproval: awaitingApproval,
      billsAwaitingTotal,
      mrApprovalPipeline:   mrPipeline,
      mrPipelineValue,
    },
  });
}

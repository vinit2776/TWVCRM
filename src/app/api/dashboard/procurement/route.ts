import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/procurement
 * Returns aggregate counts for the Procurement Overview widget.
 * Access: admin, manager only (sales_rep and floor_manager receive 403).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "fms"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [
    { count: pendingPrs },
    { count: pendingPoApprovals },
    { data: unpaidBillsData },
  ] = await Promise.all([
    // PRs in submitted state (awaiting approval)
    adminSupabase
      .from("purchase_requests")
      .select("*", { count: "exact", head: true })
      .eq("status", "submitted"),
    // POs in pending state (created, not yet ordered/confirmed)
    adminSupabase
      .from("purchase_orders")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    // Unpaid vendor bills
    adminSupabase
      .from("vendor_bills")
      .select("total_amount, amount_paid")
      .in("payment_status", ["unpaid", "partially_paid"]),
  ]);

  const unpaidBillsCount = unpaidBillsData?.length ?? 0;
  const unpaidBillsTotal = (unpaidBillsData ?? []).reduce(
    (sum, b) => sum + (b.total_amount - b.amount_paid),
    0
  );

  return NextResponse.json({
    data: {
      pending_prs: pendingPrs ?? 0,
      pending_po_approvals: pendingPoApprovals ?? 0,
      unpaid_bills: unpaidBillsCount,
      unpaid_bills_total: Math.round(unpaidBillsTotal * 100) / 100,
    },
  });
}

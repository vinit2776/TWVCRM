import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getDashboardAuth } from "@/lib/dashboard-auth";

/**
 * GET /api/dashboard/financial
 * Returns financial summary data for the Accounts role dashboard widget.
 * Access: accounts + admin only (403 for all other roles).
 *
 * Returns:
 *  - unpaid_vendor_bills: count + total outstanding amount
 *  - overdue_contracts: count of contracts with overdue/pending payment
 */
export async function GET() {
  const { user, dbUser } = await getDashboardAuth();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  if (!dbUser || !["admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [
    { data: unpaidBillsData },
    { count: overdueContracts },
  ] = await Promise.all([
    // Unpaid and partially paid vendor bills
    adminSupabase
      .from("vendor_bills")
      .select("total_amount, amount_paid")
      .in("payment_status", ["unpaid", "partially_paid"]),

    // Contracts with payment status overdue (if applicable)
    adminSupabase
      .from("contracts")
      .select("*", { count: "exact", head: true })
      .eq("payment_status", "overdue"),
  ]);

  const unpaidBillsCount = unpaidBillsData?.length ?? 0;
  const unpaidBillsTotal = (unpaidBillsData ?? []).reduce(
    (sum, b) => sum + ((b.total_amount ?? 0) - (b.amount_paid ?? 0)),
    0
  );

  return NextResponse.json({
    data: {
      unpaid_vendor_bills: unpaidBillsCount,
      unpaid_vendor_bills_total: Math.round(unpaidBillsTotal * 100) / 100,
      overdue_contracts: overdueContracts ?? 0,
    },
  });
}

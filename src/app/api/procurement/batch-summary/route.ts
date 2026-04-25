import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/procurement/batch-summary
 *
 * Returns a summary of bills due for payment tomorrow.
 * Used by the Payables page to display a "prepare funds" alert one day ahead.
 *
 * Response shape:
 * {
 *   tomorrow_date: "2026-04-21",
 *   count: 3,
 *   total_amount: 124500,
 *   bills: [{ id, bill_number, vendor_name, total_amount, payment_batch_type }]
 * }
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Compute tomorrow's date in YYYY-MM-DD
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("vendor_bills")
    .select(
      `id, bill_number, total_amount, payment_batch_type,
       procurement_vendors(name)`
    )
    .eq("payment_batch_date", tomorrowStr)
    .eq("approval_status", "approved")
    .neq("payment_status", "paid")
    .order("total_amount", { ascending: false });

  if (error) {
    console.error("[batch-summary] query error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const bills = (data ?? []).map((b) => ({
    id: b.id,
    bill_number: b.bill_number,
    vendor_name: (b.procurement_vendors as unknown as { name: string } | null)?.name ?? "—",
    total_amount: Number(b.total_amount),
    payment_batch_type: b.payment_batch_type,
  }));

  const totalAmount = bills.reduce((sum, b) => sum + b.total_amount, 0);

  return NextResponse.json({
    tomorrow_date: tomorrowStr,
    count: bills.length,
    total_amount: totalAmount,
    bills,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  // Build 12-month windows
  const months: { label: string; start: string; end: string; year: number; month: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = d.toISOString();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString();
    const label = d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "2-digit" });
    months.push({ label, start, end, year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  const [
    vendorRes,
    allPosRes,
    billsRes,
    itemPricesRes,
  ] = await Promise.all([
    supabase
      .from("procurement_vendors")
      .select("id, name, category, kyc_verified")
      .eq("id", id)
      .single(),

    // All POs for this vendor — include PR info for department linkback
    supabase
      .from("purchase_orders")
      .select(`
        id, po_number, po_type, status, total_ordered_amount, ordered_at, created_at, pr_id,
        pr:purchase_requests!purchase_orders_pr_id_fkey(pr_number, department),
        purchase_order_items(id, item_id, item_name, quantity_ordered, unit_price, total_amount)
      `)
      .eq("vendor_id", id)
      .order("created_at", { ascending: false }),

    supabase
      .from("vendor_bills")
      .select("id, bill_number, total_amount, amount_paid, due_date, invoice_date, payment_status, approval_status, created_at")
      .eq("vendor_id", id)
      .order("created_at", { ascending: false }),

    supabase
      .from("vendor_item_prices")
      .select("id, item_id, price, gst_rate, last_po_number, updated_at, procurement_items(id, name, department, unit, standard_price)")
      .eq("vendor_id", id)
      .order("updated_at", { ascending: false }),
  ]);

  if (!vendorRes.data) return NextResponse.json({ error: "Vendor not found" }, { status: 404 });

  const allPos = allPosRes.data ?? [];
  const bills = billsRes.data ?? [];

  // ── PO spend by month (12 months) ─────────────────────────────────────────
  const spendByMonth = months.map(({ label, start, end, year, month }) => {
    const monthPos = allPos.filter(
      (po) => po.created_at >= start && po.created_at < end && po.status !== "cancelled"
    );
    const amount = monthPos.reduce((sum, po) => sum + Number(po.total_ordered_amount ?? 0), 0);
    return { label, amount, year, month, start, end, count: monthPos.length };
  });

  // ── Overall PO stats ──────────────────────────────────────────────────────
  const nonCancelledPos = allPos.filter((po) => po.status !== "cancelled");
  const totalPoValue = nonCancelledPos.reduce((sum, po) => sum + Number(po.total_ordered_amount ?? 0), 0);
  const totalPoCount = nonCancelledPos.length;

  const poStatusCounts: Record<string, number> = {};
  for (const po of allPos) {
    poStatusCounts[po.status] = (poStatusCounts[po.status] ?? 0) + 1;
  }

  // ── Items ordered breakdown ───────────────────────────────────────────────
  type PoItem = {
    id: string;
    item_id: string | null;
    item_name: string;
    quantity_ordered: number;
    unit_price: number | null;
    total_amount: number | null;
  };

  const itemSpend: Record<string, { name: string; qty: number; value: number }> = {};
  for (const po of nonCancelledPos) {
    const items = (po.purchase_order_items ?? []) as unknown as PoItem[];
    for (const li of items) {
      const key = li.item_id ?? li.item_name;
      if (!itemSpend[key]) itemSpend[key] = { name: li.item_name, qty: 0, value: 0 };
      itemSpend[key].qty += Number(li.quantity_ordered ?? 0);
      itemSpend[key].value += Number(li.total_amount ?? 0);
    }
  }
  const topItems = Object.values(itemSpend)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // ── Bills / Payment performance ───────────────────────────────────────────
  const approvedBills = bills.filter((b) => b.approval_status === "approved");
  const paidBills = approvedBills.filter((b) => b.payment_status === "paid");
  const unpaidBills = approvedBills.filter((b) => b.payment_status === "unpaid" || b.payment_status === "partially_paid");

  const totalBilled = approvedBills.reduce((sum, b) => sum + Number(b.total_amount ?? 0), 0);
  const totalPaid = approvedBills.reduce((sum, b) => sum + Number(b.amount_paid ?? 0), 0);
  const totalOutstanding = totalBilled - totalPaid;

  const overdueBills = unpaidBills.filter((b) => b.due_date && b.due_date < todayStr);
  const overdueAmount = overdueBills.reduce(
    (sum, b) => sum + (Number(b.total_amount ?? 0) - Number(b.amount_paid ?? 0)),
    0
  );

  const daysToPayList = paidBills
    .filter((b) => b.due_date && b.invoice_date)
    .map((b) => {
      const invoiceDate = new Date(b.invoice_date!).getTime();
      const dueDate = new Date(b.due_date!).getTime();
      return Math.round((dueDate - invoiceDate) / (1000 * 60 * 60 * 24));
    });
  const avgPaymentTermDays = daysToPayList.length
    ? Math.round(daysToPayList.reduce((a, b) => a + b, 0) / daysToPayList.length)
    : null;

  // Prepare all POs for display (strip heavy purchase_order_items for the list, keep count)
  const allPosForDisplay = allPos.map((po) => {
    const items = (po.purchase_order_items ?? []) as unknown as PoItem[];
    return {
      id: po.id,
      po_number: po.po_number,
      po_type: po.po_type,
      status: po.status,
      total_ordered_amount: po.total_ordered_amount,
      ordered_at: po.ordered_at ?? null,
      created_at: po.created_at,
      pr_id: po.pr_id ?? null,
      pr: po.pr ?? null,
      item_count: items.length,
      top_items: items.slice(0, 3).map((i) => i.item_name),
    };
  });

  return NextResponse.json({
    data: {
      vendor: vendorRes.data,
      spendByMonth,
      totalPoValue,
      totalPoCount,
      poStatusCounts,
      recentPos: allPosForDisplay.slice(0, 10), // keep for backward compat
      allPosForDisplay,
      topItems,
      itemPrices: itemPricesRes.data ?? [],
      totalBilled,
      totalPaid,
      totalOutstanding,
      billCount: approvedBills.length,
      overdueCount: overdueBills.length,
      overdueAmount,
      avgPaymentTermDays,
      recentBills: bills.slice(0, 10),
    },
  });
}

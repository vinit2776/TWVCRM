import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import { allocationSummary } from "@/lib/procurement/shared-invoice";
import { distinctPoValues, sharedInvoiceGateError } from "@/lib/procurement/shared-invoice-server";

/**
 * GET /api/procurement/bills/[id]/shared-invoice
 *
 * The whole-invoice picture for whoever approves or pays a bill: every live bill on the same vendor
 * invoice (with its PO, share, status and delivery proof), and every other live invoice on this bill's PO.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("id, po_id, invoice_group_id")
    .eq("id", id)
    .single();
  if (!bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  const select =
    "id, bill_number, po_id, invoice_number, total_amount, approval_status, payment_status, amount_paid, invoice_file_url, purchase_orders(id, po_number, po_type, total_ordered_amount)";
  type PoRef = { id: string; po_number: string; po_type: string; total_ordered_amount: number };
  type Row = {
    id: string; bill_number: string; po_id: string | null; invoice_number: string | null; total_amount: number;
    approval_status: string; payment_status: string; amount_paid: number; invoice_file_url: string | null;
    purchase_orders: PoRef | PoRef[] | null;
  };

  let group: { id: string; invoice_number: string; invoice_total: number } | null = null;
  let groupRows: Row[] = [];
  if (bill.invoice_group_id) {
    const { data: g } = await supabase
      .from("vendor_invoice_groups")
      .select("id, invoice_number, invoice_total")
      .eq("id", bill.invoice_group_id)
      .single();
    if (g) group = { id: g.id, invoice_number: g.invoice_number, invoice_total: Number(g.invoice_total) };
    const { data: rows } = await supabase
      .from("vendor_bills")
      .select(select)
      .eq("invoice_group_id", bill.invoice_group_id)
      .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER)
      .order("created_at", { ascending: true });
    groupRows = (rows ?? []) as unknown as Row[];
  }

  let poRows: Row[] = [];
  if (bill.po_id) {
    const { data: rows } = await supabase
      .from("vendor_bills")
      .select(select)
      .eq("po_id", bill.po_id)
      .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER)
      .order("created_at", { ascending: true });
    poRows = (rows ?? []) as unknown as Row[];
  }

  // Delivery proof per PO: has any (un-reversed) delivery been recorded?
  const poIds = [...new Set([...groupRows, ...poRows].map((r) => r.po_id).filter((p): p is string => !!p))];
  const delivered = new Set<string>();
  if (poIds.length > 0) {
    const { data: receipts } = await supabase
      .from("po_delivery_receipts")
      .select("po_id")
      .in("po_id", poIds)
      .is("reversed_at", null);
    for (const r of receipts ?? []) delivered.add(r.po_id as string);
  }

  const shape = (r: Row) => {
    const po = Array.isArray(r.purchase_orders) ? r.purchase_orders[0] : r.purchase_orders;
    return {
      id: r.id,
      bill_number: r.bill_number,
      po_id: r.po_id,
      po_number: po?.po_number ?? null,
      po_type: po?.po_type ?? null,
      po_value: po ? Number(po.total_ordered_amount) : null,
      invoice_number: r.invoice_number,
      total_amount: Number(r.total_amount),
      approval_status: r.approval_status,
      payment_status: r.payment_status,
      amount_paid: Number(r.amount_paid ?? 0),
      invoice_file_url: r.invoice_file_url,
      delivery_recorded: r.po_id ? delivered.has(r.po_id) : false,
      is_current: r.id === id,
    };
  };

  const bills = groupRows.map(shape);
  const poBills = poRows.map(shape);
  const poValues = distinctPoValues(bills);
  const summary = group ? allocationSummary(group.invoice_total, bills.map((b) => b.total_amount)) : null;

  return NextResponse.json({
    group: group
      ? {
          ...group,
          allocated: summary!.allocated,
          left: summary!.left,
          combined_po_value: poValues.length >= 2 ? poValues.reduce((s, n) => s + n, 0) : null,
        }
      : null,
    bills,
    po_bills: poBills,
    gate_error: await sharedInvoiceGateError(supabase, bill.invoice_group_id ?? null),
  });
}

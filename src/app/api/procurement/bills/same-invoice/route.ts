import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { allocationSummary } from "@/lib/procurement/shared-invoice";
import { cannotJoinReason, findSameInvoiceBills } from "@/lib/procurement/shared-invoice-server";

/**
 * GET /api/procurement/bills/same-invoice?vendor_id=&po_id=&invoice_number=[&exclude_bill_id=]
 *
 * Called by the vendor-invoice form as the invoice number is typed. Says whether bills already carry
 * this number, how much of the invoice they hold, and whether this PO may be added to it. Read-only;
 * the bill route re-checks everything when the form is saved.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const sp = new URL(request.url).searchParams;
  const vendorId = sp.get("vendor_id");
  const poId = sp.get("po_id");
  const invoiceNumber = sp.get("invoice_number")?.trim();
  const excludeBillId = sp.get("exclude_bill_id");
  if (!vendorId || !invoiceNumber || !poId) return NextResponse.json({ existing: [] });

  const { data: po } = await supabase.from("purchase_orders").select("id, company_id, po_type").eq("id", poId).single();
  if (!po) return NextResponse.json({ existing: [] });

  const admin = createAdminClient();
  const existing = await findSameInvoiceBills(admin, { vendorId, companyId: po.company_id, invoiceNumber, excludeBillId });
  if (existing.length === 0) return NextResponse.json({ existing: [] });

  const groupId = existing.find((b) => b.invoice_group_id)?.invoice_group_id ?? null;
  let invoiceTotal = existing.reduce((s, b) => s + b.total_amount, 0);
  if (groupId) {
    const { data: group } = await admin.from("vendor_invoice_groups").select("invoice_total").eq("id", groupId).single();
    if (group) invoiceTotal = Number(group.invoice_total);
  }
  const { allocated, left } = allocationSummary(invoiceTotal, existing.map((b) => b.total_amount));
  const reason = cannotJoinReason(existing, { poId, poType: po.po_type });

  return NextResponse.json({
    existing,
    invoice_total: invoiceTotal,
    allocated,
    left,
    can_join: !reason,
    reason,
  });
}

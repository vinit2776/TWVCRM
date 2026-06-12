import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendPushToProcurementRoles } from "@/lib/push";
import { z } from "zod";
import { applyBillFilters, resolveFreeTextIds } from "@/lib/bills-query";
import { createVendorBill } from "@/lib/vendor-bills";

const createBillSchema = z.object({
  po_id: z.string().uuid().nullish(),
  vendor_id: z.string().uuid(),
  invoice_number: z.string().nullish(),
  invoice_date: z.string().min(1, "Invoice date is required"),
  due_date: z.string().nullish(),
  total_amount: z.number().positive("Total amount must be greater than 0"),
  gst_amount: z.number().min(0).default(0),
  notes: z.string().nullish(),
  invoice_file_url: z.string().url().nullish(),
  service_report_id: z.string().uuid().nullish(),
  replaces_bill_id: z.string().uuid().nullish(),
}).refine(
  (d) => (d.gst_amount ?? 0) <= Math.round(d.total_amount * 0.28 * 100) / 100,
  {
    message: "GST amount exceeds the maximum allowed (28% of invoice base). Please verify the invoice.",
    path: ["gst_amount"],
  },
).refine(
  (d) => {
    const today = new Date().toISOString().split("T")[0];
    return d.invoice_date >= today;
  },
  {
    message: "Invoice date cannot be in the past. Only today or a future date is allowed.",
    path: ["invoice_date"],
  },
);


export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;
  const includeTotals = searchParams.get("include_totals") === "true";

  // Resolve free-text → vendor + PO ids first so both queries share the result
  const { vendorIds, poIds } = await resolveFreeTextIds(supabase, searchParams.get("q"));

  let query = supabase
    .from("vendor_bills")
    .select(
      `*, procurement_vendors(id, name, contact_email, gstin),
       purchase_orders(id, po_number, po_type, purchase_requests(department, expenditure_type)),
       approver:users!vendor_bills_approved_by_fkey(id, full_name),
       vendor_bill_payments(id, payment_reference)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyBillFilters(query as any, searchParams, { vendorIdsFromQ: vendorIds, poIdsFromQ: poIds }) as typeof query;

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Aggregate totals over the filtered result set
  let totals = null;
  if (includeTotals) {
    let totalsQuery = supabase
      .from("vendor_bills")
      .select("total_amount, amount_paid, due_date, payment_status");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    totalsQuery = applyBillFilters(totalsQuery as any, searchParams, { vendorIdsFromQ: vendorIds, poIdsFromQ: poIds }) as typeof totalsQuery;

    const { data: allBills } = await totalsQuery;
    const todayStr = new Date().toISOString().split("T")[0];
    totals = {
      totalPayable: allBills?.reduce((s, b) => s + Number(b.total_amount), 0) ?? 0,
      totalPaid: allBills?.reduce((s, b) => s + Number(b.amount_paid), 0) ?? 0,
      overdueCount: allBills?.filter(
        (b) => b.due_date && b.due_date < todayStr && b.payment_status !== "paid"
      ).length ?? 0,
    };
  }

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
    totals,
  });
}


export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createBillSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // ── PO validation ──────────────────────────────────────────────────────────
  let poTotalAmount: number | null = null;
  let poAdvanceCredit = 0;
  if (parsed.data.po_id) {
    const { data: po } = await supabase
      .from("purchase_orders")
      .select("id, po_type, total_ordered_amount, status, unit_cost_per_cycle, advance_status, advance_amount")
      .eq("id", parsed.data.po_id)
      .single();

    if (!po) {
      return NextResponse.json({ error: "Linked purchase order not found" }, { status: 404 });
    }
    if (["cancelled"].includes(po.status)) {
      return NextResponse.json({ error: "Cannot create an invoice for a cancelled purchase order" }, { status: 422 });
    }

    poTotalAmount = Number(po.total_ordered_amount);

    // Invoice file is mandatory when linked to a PO
    if (!parsed.data.invoice_file_url) {
      return NextResponse.json({ error: "Invoice file upload is required when linking to a purchase order" }, { status: 422 });
    }

    if (po.po_type === "service") {
      // ── Service PO: must have a service_report_id ─────────────────────────
      if (!parsed.data.service_report_id) {
        return NextResponse.json({ error: "A service report must be selected before uploading an invoice" }, { status: 422 });
      }
      // Validate service report belongs to this PO
      const { data: sr } = await supabase
        .from("po_service_reports")
        .select("id")
        .eq("id", parsed.data.service_report_id)
        .eq("po_id", parsed.data.po_id)
        .single();
      if (!sr) {
        return NextResponse.json({ error: "Service report not found for this purchase order" }, { status: 404 });
      }
      // Ensure no existing bill is linked to this service report
      const { count: existingBillCount } = await supabase
        .from("vendor_bills")
        .select("*", { count: "exact", head: true })
        .eq("service_report_id", parsed.data.service_report_id);
      if (existingBillCount && existingBillCount > 0) {
        return NextResponse.json({ error: "An invoice has already been uploaded for this service report cycle" }, { status: 422 });
      }
    } else {
      // ── Goods PO: must have a delivery receipt ────────────────────────────
      const { data: deliveryReceipts } = await supabase
        .from("po_delivery_receipts")
        .select("po_delivery_receipt_items(po_item_id, qty_received)")
        .eq("po_id", parsed.data.po_id);
      if (!deliveryReceipts || deliveryReceipts.length === 0) {
        return NextResponse.json({ error: "A delivery must be recorded before uploading a vendor invoice" }, { status: 422 });
      }

      // Calculate proportionate received value for shortfall detection
      const { data: poItems } = await supabase
        .from("purchase_order_items")
        .select("id, unit_price")
        .eq("po_id", parsed.data.po_id);

      const priceMap: Record<string, number> = {};
      for (const item of poItems ?? []) {
        priceMap[item.id] = Number(item.unit_price ?? 0);
      }

      let receivedValue = 0;
      for (const receipt of deliveryReceipts) {
        for (const ri of receipt.po_delivery_receipt_items ?? []) {
          receivedValue += (priceMap[ri.po_item_id] ?? 0) * Number(ri.qty_received);
        }
      }

      // If there is a shortfall, cap invoice at the received value (not the full PO value)
      if (receivedValue < (poTotalAmount ?? 0)) {
        if (parsed.data.total_amount > receivedValue) {
          return NextResponse.json({
            error: `Invoice amount (₹${parsed.data.total_amount.toLocaleString("en-IN")}) exceeds the proportionate value of goods received (₹${receivedValue.toLocaleString("en-IN")}). Only goods worth ₹${receivedValue.toLocaleString("en-IN")} have been received against the PO value of ₹${(poTotalAmount ?? 0).toLocaleString("en-IN")}.`,
          }, { status: 422 });
        }
        // Override poTotalAmount so the generic ceiling check below does not fire on the full PO value
        poTotalAmount = receivedValue;
      }
    }

    // Amount must not exceed ceiling (per cycle for service POs, full PO value for goods)
    const ceiling = po.po_type === "service" && po.unit_cost_per_cycle
      ? Number(po.unit_cost_per_cycle)
      : poTotalAmount;
    if (ceiling !== null && ceiling > 0 && parsed.data.total_amount > ceiling) {
      return NextResponse.json({
        error: `Invoice amount (₹${parsed.data.total_amount.toLocaleString("en-IN")}) cannot exceed the ${po.po_type === "service" ? "cycle cost" : "PO value"} (₹${ceiling.toLocaleString("en-IN")})`,
      }, { status: 422 });
    }

    // Pre-credit advance if already processed
    if (po.advance_status === "processed" && po.advance_amount) {
      poAdvanceCredit = Math.min(Number(po.advance_amount), parsed.data.total_amount);
    }
  }

  // ── Hard-block exact duplicate invoices ───────────────────────────────────
  // Same vendor + same invoice number on any non-rejected bill = duplicate.
  // Rejected bills are excluded so a re-submission after rejection is allowed.
  if (parsed.data.invoice_number?.trim()) {
    const { count: dupCount } = await supabase
      .from("vendor_bills")
      .select("*", { count: "exact", head: true })
      .eq("vendor_id", parsed.data.vendor_id)
      .eq("invoice_number", parsed.data.invoice_number.trim())
      .neq("approval_status", "rejected");

    if (dupCount && dupCount > 0) {
      return NextResponse.json(
        { error: `Invoice number "${parsed.data.invoice_number.trim()}" already exists for this vendor. Check Vendor Payments to avoid duplicate processing.` },
        { status: 409 }
      );
    }
  }

  // ── Create the bill (number generation, insert, PO status update, audit) ───
  const initialPaymentStatus =
    poAdvanceCredit >= parsed.data.total_amount ? "paid" :
    poAdvanceCredit > 0 ? "partially_paid" :
    "unpaid";

  let bill: { id: string; bill_number: string };
  try {
    bill = await createVendorBill(supabase, {
      po_id: parsed.data.po_id ?? null,
      vendor_id: parsed.data.vendor_id,
      invoice_number: parsed.data.invoice_number ?? null,
      invoice_date: parsed.data.invoice_date,
      due_date: parsed.data.due_date ?? null,
      total_amount: parsed.data.total_amount,
      gst_amount: parsed.data.gst_amount ?? 0,
      notes: parsed.data.notes ?? null,
      invoice_file_url: parsed.data.invoice_file_url ?? null,
      service_report_id: parsed.data.service_report_id ?? null,
      replaces_bill_id: parsed.data.replaces_bill_id ?? null,
      amount_paid: poAdvanceCredit,
      payment_status: initialPaymentStatus,
      created_by: dbUser.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create bill";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Notify admins/managers that a new invoice needs approval
  sendPushToProcurementRoles({
    title: "Invoice Pending Approval",
    body: `${bill.bill_number} — ₹${parsed.data.total_amount.toLocaleString("en-IN")} requires approval`,
    url: `/procurement/bills/${bill.id}`,
    tag: `bill-approval-${bill.id}`,
  }).catch((err) => console.error("[push] new bill notification failed:", err));

  return NextResponse.json({ data: { id: bill.id, bill_number: bill.bill_number } }, { status: 201 });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";
import { resolveLineItemQty, resolveLineItemRate, withProrationBreakdown } from "@/lib/billing-pdf-utils";
import { computeGstAndRounding } from "@/lib/gst-math";
import QRCode from "qrcode";

export const maxDuration = 30;

/**
 * GET /api/billing-statements/[id]/proforma-pdf
 *
 * Returns the proforma invoice as a downloadable PDF.
 * Rebuilds the PDF on-the-fly using stored statement data.
 * Includes QR code if a Razorpay payment link exists.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const adminSupabase = await createAdminClient();

  const { data: statement, error: fetchErr } = await adminSupabase
    .from("billing_statements")
    .select(`
      *,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, total_amount, subtotal, tax_percentage,
        start_date, end_date, next_billing_date, billing_cycle, location_id, items,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile, street, city, zip_code)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile, street, city, zip_code)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile, street, city, zip_code)
      ),
      usage_charges:usage_charges(id, description, quantity, unit_price, total)
    `)
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }
  if (statement.status === "draft") {
    return NextResponse.json({ error: "Statement is not yet finalized" }, { status: 400 });
  }
  if (statement.status === "voided") {
    return NextResponse.json({ error: "Statement is voided" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposal = statement.proposal as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoice = statement.invoice as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = (contract?.lead ?? proposal?.lead ?? invoice?.lead) as any;
  const partyRef: string = contract?.contract_number ?? proposal?.proposal_number ?? invoice?.invoice_number ?? "";

  if (!contract && !proposal && !invoice) {
    return NextResponse.json({ error: "No contract, proposal, or invoice linked to this statement" }, { status: 400 });
  }

  // Recalculate totals — derive from the structured line_items sections (the
  // same data the table below is built from) so the totals box can never
  // drift from what's printed. Falls back to the legacy per-field sum only
  // for statements predating the structured line_items JSONB.
  const usageCharges = (statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number }[];
  const usageAmount = usageCharges.reduce((s, c) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const structuredSections = (statement.line_items || []) as Array<{ type: string; label: string; items: Record<string, unknown>[]; subtotal: number }>;
  const subtotal = structuredSections.length > 0
    ? structuredSections.reduce((s, sec) => s + Number(sec.subtotal || 0), 0)
    : fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 18);

  // Place of supply is always Tamil Nadu — service rendered at TWV premises (always CGST+SGST)
  const isInterstate = false;
  const { cgst, sgst, igst, totalAmount } = computeGstAndRounding(subtotal, taxPercentage);

  // Fetch UPI ID
  let upiId: string | undefined;
  try {
    const { data: settings } = await adminSupabase.from("app_settings").select("key, value").eq("key", "upi_id");
    const settingsMap: Record<string, string> = {};
    (settings || []).forEach((s: { key: string; value: string }) => { settingsMap[s.key] = s.value; });
    upiId = settingsMap.upi_id;
  } catch { /* continue */ }

  // Build line items
  const lineItems: GstInvoiceData["lineItems"] = [];

  if (structuredSections.length > 0) {
    for (const section of structuredSections) {
      for (const item of section.items) {
        const desc = item.description || item.booking_number || section.label;
        let label = String(desc);
        if (section.type === "booking_usage" && item.date) {
          label = [String(item.date), item.space ? String(item.space) : "", item.time ? String(item.time) : "", item.duration ? String(item.duration) : ""].filter(Boolean).join(" · ");
        }
        lineItems.push({
          description: withProrationBreakdown(label || section.label, item),
          hsnSac: resolveHsnCode(section.type, String(item.hsn_sac_code || ""), section.label),
          qty: resolveLineItemQty(item, "proforma-pdf"),
          rate: resolveLineItemRate(item),
          amount: Number(item.amount || 0),
        });
      }
    }
  } else {
    if (fixedAmount > 0) {
      lineItems.push({ description: contract?.title || `Workspace — ${partyRef}`, hsnSac: resolveHsnCode("rent"), qty: 1, rate: fixedAmount, amount: fixedAmount });
    }
    for (const charge of usageCharges) {
      lineItems.push({ description: charge.description, hsnSac: resolveHsnCode("ad_hoc_charges", (charge as { hsn_sac_code?: string | null }).hsn_sac_code), qty: Number(charge.quantity || 1), rate: Number(charge.unit_price), amount: Number(charge.total) });
    }
  }

  // Payment link + QR
  const razorpayLinkUrl: string | null = statement.razorpay_payment_link_url as string | null;
  let razorpayQrBase64: string | undefined;
  let razorpayExpiry: string | undefined;

  if (razorpayLinkUrl) {
    try {
      razorpayQrBase64 = await QRCode.toDataURL(razorpayLinkUrl, { width: 200, margin: 1, errorCorrectionLevel: "M" });
    } catch { /* skip */ }

    // Estimate expiry: 15 days from proforma_sent_at (or from now if re-downloading)
    const sentAt = statement.proforma_sent_at ? new Date(statement.proforma_sent_at) : new Date();
    const expiryDate = new Date(sentAt.getTime() + 15 * 24 * 60 * 60 * 1000);
    razorpayExpiry = expiryDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  }

  const proformaRef = statement.statement_number as string;
  const invoiceData: GstInvoiceData = {
    invoiceNumber: proformaRef,
    // Rent: 1st of billed month. Usage: date PDF is downloaded (re-issued on demand).
    invoiceDate: (statement.statement_type as string) === "rent"
      ? (statement.period_start as string)
      : new Date().toISOString().slice(0, 10),
    isProforma: true,
    compactLineItems: (statement.statement_type as string) === "reimbursement",
    buyerName: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer",
    buyerAddress: [lead?.street, lead?.city, lead?.state, lead?.zip_code].filter(Boolean).join(", ") || undefined,
    buyerGstin: lead?.gst_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart: statement.period_start as string,
    periodEnd: statement.period_end as string,
    contractNumber: partyRef,
    lineItems,
    subtotal,
    cgst,
    sgst,
    igst,
    totalAmount,
    isInterstate,
    taxPercentage,
    razorpayUrl: razorpayLinkUrl ?? undefined,
    razorpayQrBase64,
    razorpayExpiry,
    upiId,
  };

  const doc = generateGstInvoicePDF(invoiceData);
  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  const filename = `Proforma-${proformaRef.replace(/\//g, "-")}.pdf`;

  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}

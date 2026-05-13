import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
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
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
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
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile)
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
  const lead = contract?.lead as any;

  if (!contract) {
    return NextResponse.json({ error: "No contract linked to this statement" }, { status: 400 });
  }

  // Recalculate totals
  const usageCharges = (statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number }[];
  const usageAmount = usageCharges.reduce((s, c) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const subtotal = fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 18);

  const buyerState = (lead?.state || "").toLowerCase().trim();
  const isInterstate = buyerState !== "" && buyerState !== "tamil nadu" && buyerState !== "tn";

  let cgst = 0, sgst = 0, igst = 0;
  if (isInterstate) {
    igst = Math.round(subtotal * (taxPercentage / 100) * 100) / 100;
  } else {
    cgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
    sgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
  }
  const totalAmount = subtotal + cgst + sgst + igst;

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
  const structuredSections = (statement.line_items || []) as Array<{ type: string; label: string; items: Record<string, unknown>[]; subtotal: number }>;

  if (structuredSections.length > 0) {
    for (const section of structuredSections) {
      for (const item of section.items) {
        const desc = item.description || item.booking_number || section.label;
        let label = String(desc);
        if (section.type === "booking_usage" && item.date) {
          label = [String(item.date), item.space ? String(item.space) : "", item.time ? String(item.time) : "", item.duration ? String(item.duration) : ""].filter(Boolean).join(" · ");
        }
        lineItems.push({
          description: label || section.label,
          hsnSac: "997212",
          qty: Number(item.quantity || item.billable || 1),
          rate: Number(item.unit_price || item.rate || item.amount || 0),
          amount: Number(item.amount || 0),
        });
      }
    }
  } else {
    if (fixedAmount > 0) {
      lineItems.push({ description: contract.title || `Workspace — ${contract.contract_number}`, hsnSac: "997212", qty: 1, rate: fixedAmount, amount: fixedAmount });
    }
    for (const charge of usageCharges) {
      lineItems.push({ description: charge.description, hsnSac: "997212", qty: Number(charge.quantity || 1), rate: Number(charge.unit_price), amount: Number(charge.total) });
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
    invoiceDate: statement.proforma_sent_at
      ? new Date(statement.proforma_sent_at).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    isProforma: true,
    buyerName: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer",
    buyerGstin: lead?.gst_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart: statement.period_start as string,
    periodEnd: statement.period_end as string,
    contractNumber: contract.contract_number,
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
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}

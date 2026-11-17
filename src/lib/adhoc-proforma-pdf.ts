import type { SupabaseClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { buildProformaPdf, type ProformaPdfResult } from "@/lib/proforma-pdf";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";
import { computeGstAndRounding } from "@/lib/gst-math";
import { invoiceParty, type InvoiceCaseLike } from "@/lib/invoice-party";

interface InvoiceItem { description: string; quantity: number; unit_price: number; total: number }

/**
 * The ad-hoc proforma PDF for a proforma_invoices row — the one document
 * everywhere (invoice screens, email attachment, Receivables).
 *
 * Once an invoice has been sent it is mirrored into billing_statements
 * (adhoc-invoice-mirror.ts) and Receivables renders that statement, so we hand
 * off to the very same builder rather than re-deriving it. Before that there is
 * no statement yet, so the same layout is built straight from the invoice; the
 * invoice number stands in for the TWV-BS number until one exists.
 * Read-only: no email, no Razorpay call, no mutation. Auth is the caller's job.
 */
export async function buildAdhocInvoicePdf(admin: SupabaseClient, invoiceId: string): Promise<ProformaPdfResult> {
  const { data: statement } = await admin
    .from("billing_statements")
    .select("id")
    .eq("invoice_id", invoiceId)
    .neq("status", "voided")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (statement) return buildProformaPdf(admin, statement.id as string);

  const { data: invoice } = await admin
    .from("proforma_invoices")
    .select("*, lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, company, state, gst_number, pan_number, street, city, zip_code), case:cases!proforma_invoices_case_id_fkey(client_name, client_company_name, client_email, client_phone, client_gst_number, aggregator_id, bill_to, aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone, gst_number))")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return { ok: false, error: "Invoice not found", status: 404 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = invoice.lead as any;
  const party = invoiceParty({ lead, case: invoice.case as unknown as InvoiceCaseLike | null });
  const buyerName = party?.name || "Customer";
  const hsnSac = resolveHsnCode("ad_hoc_charges");

  const lineItems: GstInvoiceData["lineItems"] = ((invoice.items || []) as InvoiceItem[]).map((item) => ({
    description: item.description,
    hsnSac,
    qty: Number(item.quantity),
    rate: Number(item.unit_price),
    amount: Number(item.total),
  }));
  const subtotal = Number(invoice.subtotal);
  const taxPercentage = Number(invoice.tax_percentage || 18);
  // Same math the statement path uses, so the unsent and sent PDFs agree.
  const { cgst, sgst, igst, totalAmount } = computeGstAndRounding(subtotal, taxPercentage);

  const razorpayUrl: string | null = invoice.razorpay_link_url ?? null;
  let razorpayQrBase64: string | undefined;
  if (razorpayUrl) {
    try {
      razorpayQrBase64 = await QRCode.toDataURL(razorpayUrl, { width: 200, margin: 1, errorCorrectionLevel: "M" });
    } catch { /* skip */ }
  }
  let upiId: string | undefined;
  try {
    const { data: setting } = await admin.from("app_settings").select("value").eq("key", "upi_id").maybeSingle();
    upiId = (setting?.value as string | undefined) ?? undefined;
  } catch { /* continue */ }

  const today = new Date().toISOString().slice(0, 10);
  const data: GstInvoiceData = {
    invoiceNumber: invoice.invoice_number,
    invoiceDate: today,
    isProforma: true,
    adhoc: true,
    buyerName,
    buyerAddress: [lead?.street, lead?.city, lead?.state, lead?.zip_code].filter(Boolean).join(", ") || undefined,
    buyerGstin: party?.gstin || undefined,
    buyerPan: lead?.pan_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart: today,
    periodEnd: today,
    contractNumber: invoice.invoice_number,
    lineItems,
    subtotal,
    cgst,
    sgst,
    igst,
    totalAmount,
    isInterstate: false,
    taxPercentage,
    razorpayUrl: razorpayUrl ?? undefined,
    razorpayQrBase64,
    upiId,
  };

  const doc = generateGstInvoicePDF(data);
  return {
    ok: true,
    buffer: Buffer.from(doc.output("arraybuffer")),
    filename: `Proforma-${String(invoice.invoice_number).replace(/\//g, "-")}.pdf`,
  };
}

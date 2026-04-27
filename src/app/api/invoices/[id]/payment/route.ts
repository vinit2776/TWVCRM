import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

/**
 * POST /api/invoices/[id]/payment
 * Records payment received for an adhoc proforma invoice and
 * sends a GST tax invoice to the customer.
 *
 * Body (JSON):
 *   amount      (required) number
 *   reference   (optional) UTR / transaction ID
 *   notes       (optional) string
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const amount = parseFloat(body.amount);
  const reference = (body.reference as string | undefined)?.trim() || null;
  const notes = (body.notes as string | undefined)?.trim() || null;

  if (isNaN(amount) || amount <= 0)
    return NextResponse.json({ error: "Valid payment amount is required" }, { status: 400 });

  // Fetch invoice + lead
  const { data: invoice } = await supabase
    .from("proforma_invoices")
    .select("*, lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, email, company)")
    .eq("id", id)
    .single();

  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (invoice.status === "paid")
    return NextResponse.json({ error: "Invoice is already marked as paid" }, { status: 400 });

  // Build GST invoice number (reuse invoice number with -TAX suffix for simplicity)
  const gstInvoiceNumber = `${invoice.invoice_number}-TAX`;
  const paidAt = new Date().toISOString();

  // Update invoice
  const { error: updateErr } = await supabase
    .from("proforma_invoices")
    .update({
      status: "paid",
      paid_at: paidAt,
      payment_reference: reference,
      gst_invoice_number: gstInvoiceNumber,
      gst_invoice_sent_at: paidAt,
      gst_invoice_sent_to: invoice.lead?.email || null,
    })
    .eq("id", id);

  if (updateErr) {
    console.error("[invoice payment] update error:", updateErr);
    return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
  }

  // Send GST invoice email to customer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = invoice.lead as any;
  const customerEmail = lead?.email;
  const customerName = lead
    ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
    : "Customer";

  if (customerEmail) {
    const paidDate = new Date(paidAt).toLocaleDateString("en-IN", {
      year: "numeric", month: "long", day: "numeric",
    });
    const totalFormatted = `₹${Number(invoice.total_amount).toLocaleString("en-IN")}`;

    // Tax breakdown (assume total_amount is inclusive of GST at invoice's tax_percentage)
    const taxPct = Number(invoice.tax_percentage || 18);
    const baseAmount = Number(invoice.subtotal || invoice.total_amount);
    const gstAmount = Number(invoice.tax_amount || 0);
    const cgst = gstAmount / 2;
    const sgst = gstAmount / 2;

    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [customerEmail],
      subject: `GST Tax Invoice ${gstInvoiceNumber} — The WorkVilla`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">GST Tax Invoice</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">Thank you for your payment. Please find below your GST tax invoice for <strong>${invoice.title}</strong>.</p>

            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:20px 0;">
              <p style="color:#166534;font-size:13px;font-weight:700;margin:0 0 8px;">✅ PAYMENT RECEIVED — ${paidDate}</p>
              <table style="border-collapse:collapse;width:100%;">
                <tr><td style="padding:4px 0;color:#555;font-size:13px;width:50%;">Amount Paid</td><td style="padding:4px 0;font-weight:bold;color:#166534;font-size:16px;">${totalFormatted}</td></tr>
                ${reference ? `<tr><td style="padding:4px 0;color:#555;font-size:13px;">Reference / UTR</td><td style="padding:4px 0;font-family:monospace;color:#333;font-size:13px;">${reference}</td></tr>` : ""}
              </table>
            </div>

            <p style="color:#015E65;font-size:13px;font-weight:700;margin:20px 0 8px;letter-spacing:0.3px;">TAX INVOICE DETAILS</p>
            <table style="border-collapse:collapse;width:100%;background:#f8fafc;border-radius:6px;margin-bottom:16px;border:1px solid #e2e8f0;">
              <tr style="background:#015E65;">
                <th style="padding:10px 16px;color:white;text-align:left;font-size:12px;">GST Invoice #</th>
                <th style="padding:10px 16px;color:white;text-align:left;font-size:12px;">Date</th>
                <th style="padding:10px 16px;color:white;text-align:right;font-size:12px;">GSTIN (Supplier)</th>
              </tr>
              <tr>
                <td style="padding:10px 16px;color:#015E65;font-weight:bold;font-size:14px;">${gstInvoiceNumber}</td>
                <td style="padding:10px 16px;color:#333;font-size:13px;">${paidDate}</td>
                <td style="padding:10px 16px;color:#333;font-family:monospace;font-size:12px;text-align:right;">33AAACU4245J1ZF</td>
              </tr>
            </table>

            <table style="border-collapse:collapse;width:100%;margin-bottom:8px;border:1px solid #e2e8f0;border-radius:6px;">
              <thead>
                <tr style="background:#f8fafc;">
                  <th style="padding:10px 16px;text-align:left;font-size:12px;color:#555;border-bottom:1px solid #e2e8f0;">Description</th>
                  <th style="padding:10px 16px;text-align:right;font-size:12px;color:#555;border-bottom:1px solid #e2e8f0;">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding:10px 16px;color:#333;font-size:13px;border-bottom:1px solid #f1f5f9;">${invoice.title}</td>
                  <td style="padding:10px 16px;color:#333;font-size:13px;text-align:right;border-bottom:1px solid #f1f5f9;">₹${baseAmount.toLocaleString("en-IN")}</td>
                </tr>
                <tr>
                  <td style="padding:8px 16px;color:#666;font-size:12px;border-bottom:1px solid #f1f5f9;">CGST (${taxPct / 2}%)</td>
                  <td style="padding:8px 16px;color:#666;font-size:12px;text-align:right;border-bottom:1px solid #f1f5f9;">₹${cgst.toLocaleString("en-IN")}</td>
                </tr>
                <tr>
                  <td style="padding:8px 16px;color:#666;font-size:12px;border-bottom:1px solid #e2e8f0;">SGST (${taxPct / 2}%)</td>
                  <td style="padding:8px 16px;color:#666;font-size:12px;text-align:right;border-bottom:1px solid #e2e8f0;">₹${sgst.toLocaleString("en-IN")}</td>
                </tr>
                <tr style="background:#015E65;">
                  <td style="padding:12px 16px;color:white;font-weight:bold;font-size:14px;">Total</td>
                  <td style="padding:12px 16px;color:white;font-weight:bold;font-size:16px;text-align:right;">${totalFormatted}</td>
                </tr>
              </tbody>
            </table>

            <p style="color:#555;font-size:12px;margin:8px 0 20px;">
              Supplier: Sree Design Infrastructure Pvt Ltd | ${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>
              GSTIN: 33AAACU4245J1ZF | SAC Code: 997212
            </p>

            <p style="color:#333;font-size:14px;">Please retain this email as your tax invoice for accounting and GST input credit purposes.</p>
            <p style="color:#333;font-size:14px;margin-top:16px;">Warm regards,<br/><strong>The WorkVilla Team</strong></p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034</p>
          </div>
        </div>
      `,
    }).catch(console.error);
  }

  return NextResponse.json({
    message: "Payment recorded and GST invoice sent",
    gst_invoice_number: gstInvoiceNumber,
    customer_email: customerEmail || null,
    notes,
  });
}

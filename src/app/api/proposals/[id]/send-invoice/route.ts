import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

/**
 * POST /api/proposals/[id]/send-invoice
 * Generates a prorated GST invoice for the first month and emails it to the customer
 * with the Razorpay payment link.
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
  const { occupation_start_date } = body;

  if (!occupation_start_date) {
    return NextResponse.json({ error: "Occupation start date is required" }, { status: 400 });
  }

  // Fetch proposal with lead
  const { data: proposal } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, phone, mobile, state, gst_number)")
    .eq("id", id)
    .single();

  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  // Validate deposit status
  const depositRequired = Number(proposal.security_deposit_months || 0) > 0;
  if (depositRequired && proposal.deposit_payment_status !== "paid") {
    return NextResponse.json({ error: "Security deposit must be paid before sending the invoice" }, { status: 400 });
  }

  if (!["sent", "accepted"].includes(proposal.status)) {
    return NextResponse.json({ error: "Proposal must be sent or accepted" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
  const customerEmail = lead?.email;

  // Proration calculation
  const startDate = new Date(occupation_start_date + "T00:00:00Z");
  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth();
  const dayOfMonth = startDate.getUTCDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysRemaining = daysInMonth - dayOfMonth + 1;
  const prorationFactor = daysRemaining / daysInMonth;

  const subtotal = Number(proposal.subtotal || proposal.total_amount || 0);
  const proratedSubtotal = Math.round(subtotal * prorationFactor * 100) / 100;
  const taxPercentage = Number(proposal.tax_percentage || 18);

  // GST split
  const buyerState = (lead?.state || "").toLowerCase().trim();
  const isInterstate = buyerState !== "" && buyerState !== "tamil nadu" && buyerState !== "tn";

  let cgst = 0, sgst = 0, igst = 0;
  if (isInterstate) {
    igst = Math.round(proratedSubtotal * (taxPercentage / 100) * 100) / 100;
  } else {
    cgst = Math.round(proratedSubtotal * (taxPercentage / 200) * 100) / 100;
    sgst = Math.round(proratedSubtotal * (taxPercentage / 200) * 100) / 100;
  }
  const taxAmount = cgst + sgst + igst;
  const totalAmount = proratedSubtotal + taxAmount;

  // Generate invoice number
  const adminSupabase = await createAdminClient();
  const fyStart = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const fyEnd = fyStart + 1;
  const fyPrefix = `TWV/INV/${String(fyStart).slice(-2)}-${String(fyEnd).slice(-2)}/`;
  const { count: existingCount } = await adminSupabase
    .from("billing_statements")
    .select("id", { count: "exact", head: true })
    .like("gst_invoice_number", `${fyPrefix}%`);
  const invoiceNumber = `${fyPrefix}${String((existingCount || 0) + 1).padStart(4, "0")}`;

  // Create/reuse Razorpay payment link for prorated amount
  let razorpayUrl = proposal.razorpay_payment_link_url;

  if (!razorpayUrl) {
    // Create new link for prorated amount
    const { data: rzpSettings } = await adminSupabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

    const rzpMap: Record<string, string> = {};
    (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

    if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
      const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
      const customerPhone = lead?.phone || lead?.mobile;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload: Record<string, any> = {
        amount: Math.round(totalAmount * 100),
        currency: "INR",
        description: `Invoice ${invoiceNumber} — ${proposal.proposal_number} — The WorkVilla`,
        reference_id: `${proposal.proposal_number}-MON`,
        expire_by: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        notify: { sms: !!customerPhone, email: !!customerEmail },
        reminder_enable: true,
        notes: { proposal_id: id, proposal_number: proposal.proposal_number, type: "monthly_charge" },
        callback_url: `${appUrl}/proposals`,
        callback_method: "get",
      };

      if (customerName || customerEmail || customerPhone) {
        payload.customer = {};
        if (customerName) payload.customer.name = customerName;
        if (customerEmail) payload.customer.email = customerEmail;
        if (customerPhone) payload.customer.contact = customerPhone.replace(/\s/g, "");
      }

      const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (rzpRes.ok) {
        const linkData = await rzpRes.json();
        razorpayUrl = linkData.short_url;
        await supabase.from("proposals").update({
          razorpay_payment_link_id: linkData.id,
          razorpay_payment_link_url: linkData.short_url,
        }).eq("id", id);
      }
    }
  }

  // Note: Generic UPI QR code removed — not transaction-specific, no traceability.
  // Payments are tracked via Razorpay payment link only.

  // Build line items (prorated)
  const periodEnd = `${year}-${String(month + 1).padStart(2, "0")}-${daysInMonth}`;
  const lineItems: GstInvoiceData["lineItems"] = (proposal.items || []).map((item: { description: string; quantity: number; unit_price: number; unit?: string }) => {
    const proratedRate = Math.round(item.unit_price * prorationFactor * 100) / 100;
    return {
      description: item.description + (prorationFactor < 1 ? ` (${daysRemaining}/${daysInMonth} days)` : ""),
      hsnSac: "997212",
      qty: item.quantity,
      rate: proratedRate,
      amount: Math.round(item.quantity * proratedRate * 100) / 100,
    };
  });

  // Generate GST invoice PDF
  const invoiceData: GstInvoiceData = {
    invoiceNumber,
    invoiceDate: new Date().toISOString().slice(0, 10),
    buyerName: lead?.company || customerName,
    buyerGstin: lead?.gst_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart: occupation_start_date,
    periodEnd,
    contractNumber: proposal.proposal_number,
    lineItems,
    subtotal: proratedSubtotal,
    cgst, sgst, igst,
    totalAmount,
    isInterstate,
    taxPercentage,
    razorpayUrl: razorpayUrl || undefined,
  };

  const doc = generateGstInvoicePDF(invoiceData);
  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

  // Upload PDF
  const storagePath = `invoices/${invoiceNumber.replace(/\//g, "-")}.pdf`;
  await adminSupabase.storage.from("crm-documents").upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

  // Store occupation date on proposal
  await supabase.from("proposals").update({ occupation_start_date }).eq("id", id);

  // Email to customer + CC accounts/managers
  if (customerEmail) {
    const { data: ccUsers } = await adminSupabase
      .from("users")
      .select("email")
      .in("role", ["admin", "manager", "accounts"])
      .eq("is_active", true);
    const ccEmails = (ccUsers || []).map((u) => u.email).filter(Boolean);
    const allRecipients = [customerEmail, ...ccEmails].filter(Boolean);

    const periodLabel = startDate.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    const startLabel = startDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: allRecipients,
      subject: `Invoice ${invoiceNumber} — ${proposal.proposal_number} — The WorkVilla`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Tax Invoice</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">Thank you for choosing The WorkVilla. Please find attached your tax invoice for the period <strong>${startLabel}</strong> to <strong>${new Date(periodEnd + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</strong>.</p>

            ${prorationFactor < 1 ? `
            <!-- Proration explanation -->
            <div style="background:#f0faf5;border-left:4px solid #015E65;padding:14px 18px;margin:16px 0;border-radius:0 6px 6px 0;">
              <p style="color:#015E65;font-size:13px;font-weight:600;margin:0 0 8px;">About this invoice</p>
              <p style="color:#333;font-size:13px;margin:0 0 4px;">Your regular monthly charge is <strong>Rs. ${subtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })} + GST</strong> per month.</p>
              <p style="color:#333;font-size:13px;margin:0 0 4px;">Since your occupation begins on <strong>${startLabel}</strong>, this invoice covers <strong>${daysRemaining} of ${daysInMonth} days</strong> in ${periodLabel}.</p>
              <p style="color:#333;font-size:13px;margin:0;">Prorated amount: Rs. ${subtotal.toLocaleString("en-IN")} x ${daysRemaining}/${daysInMonth} = <strong>Rs. ${proratedSubtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</strong> + GST</p>
              <p style="color:#666;font-size:12px;margin:8px 0 0;font-style:italic;">From next month onwards, you will be billed the full monthly amount of Rs. ${subtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })} + GST.</p>
            </div>` : `
            <p style="color:#333;font-size:13px;margin:8px 0 0;">Your monthly charge: <strong>Rs. ${subtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })} + GST</strong></p>
            `}

            <!-- Invoice summary -->
            <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;background:#f7f8fa;border-radius:6px;">
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Invoice No.</td><td style="padding:10px 16px;font-weight:600;">${invoiceNumber}</td></tr>
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Proposal Ref.</td><td style="padding:10px 16px;">${proposal.proposal_number}</td></tr>
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Subtotal${prorationFactor < 1 ? " (prorated)" : ""}</td><td style="padding:10px 16px;">Rs. ${proratedSubtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">GST @${taxPercentage}%</td><td style="padding:10px 16px;">Rs. ${taxAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
              <tr style="background:#015E65;"><td style="padding:10px 16px;color:white;font-weight:600;">Amount Payable</td><td style="padding:10px 16px;color:white;font-weight:700;font-size:16px;">Rs. ${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
            </table>

            ${razorpayUrl ? `
            <div style="text-align:center;margin:24px 0;">
              <a href="${razorpayUrl}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay Now — Rs. ${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</a>
              <p style="color:#666;font-size:11px;margin:8px 0 0;">Secure payment via Razorpay</p>
            </div>` : ""}

            <p style="color:#015E65;font-size:13px;font-weight:bold;margin:20px 0 8px;">Bank Transfer</p>
            <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;">
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Account Name</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Account No.</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">IFSC Code</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;">Bank & Branch</td><td style="padding:8px 16px;color:#333;">${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}</td></tr>
            </table>
            ${razorpayUrl ? `<p style="color:#666;font-size:12px;margin-top:4px;">Online: <a href="${razorpayUrl}" style="color:#015E65;">${razorpayUrl}</a></p>` : ""}

            <p style="color:#333;font-size:14px;margin-top:24px;">We look forward to welcoming you to The WorkVilla.</p>
            <p style="color:#333;font-size:14px;">Warm regards,<br/><strong>The WorkVilla Team</strong></p>
            <p style="color:#666;font-size:12px;margin-top:12px;">For any queries, write to us at <a href="mailto:space@theworkvilla.com" style="color:#015E65;">space@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
          </div>
        </div>`,
      attachments: [{ filename: `${invoiceNumber.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
    }).catch(console.error);
  }

  return NextResponse.json({
    success: true,
    invoiceNumber,
    proratedSubtotal,
    taxAmount,
    totalAmount,
    daysRemaining,
    daysInMonth,
    prorationFactor: Math.round(prorationFactor * 100) / 100,
    razorpayUrl,
  });
}

export const maxDuration = 30;

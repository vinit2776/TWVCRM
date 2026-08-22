/**
 * VO Renewal — PI generation, Razorpay link creation, reminder dispatch
 *
 * Called by the /api/cron/vo-renewal cron and by the webhook handler
 * when a renewal payment is received.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { messaging } from "@/lib/whatsapp";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { logAudit } from "@/lib/audit";
import { formatCurrency, formatDate } from "@/lib/utils";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  addBrandHeader,
  addFooter,
  BRAND_TEAL,
  BRAND_DARK,
  COMPANY_NAME,
} from "@/lib/pdf-utils";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoCaseForRenewal {
  id: string;
  case_number: string;
  client_name: string;
  client_company_name?: string | null;
  client_email?: string | null;
  client_phone?: string | null;
  client_gst_number?: string | null;
  rate: number;
  tenure_months: number;
  start_date: string;
  end_date: string;
  /** Agreed escalation applied to the license fee on renewal; 0 renews flat. */
  renewal_escalation_percentage?: number | null;
  purpose: string;
  renewal_billing_statement_id?: string | null;
  renewal_reminder_count?: number;
  renewal_grace_ends_at?: string | null;
  location?: { name: string; address?: string; city?: string; state?: string } | null;
}

export interface RenewalResult {
  statementId: string;
  razorpayLinkId: string;
  razorpayLinkUrl: string;
  emailSent: boolean;
  whatsAppSent: boolean;
}

// ---------------------------------------------------------------------------
// PI PDF generator
// ---------------------------------------------------------------------------

export function generateRenewalPI(params: {
  caseData: VoCaseForRenewal;
  piNumber: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  razorpayUrl?: string;
}): Buffer {
  const { caseData, piNumber, periodStart, periodEnd, dueDate, razorpayUrl } = params;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  autoTable; // suppress unused import

  const marginLeft = 15;
  const marginRight = 15;
  const contentWidth = doc.internal.pageSize.getWidth() - marginLeft - marginRight;

  let y = addBrandHeader(doc);

  // Title
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(BRAND_TEAL[0], BRAND_TEAL[1], BRAND_TEAL[2]);
  doc.text("PROFORMA INVOICE", marginLeft, y);
  y += 8;

  // Invoice meta
  doc.setFontSize(9);
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);
  const metaRows = [
    ["PI Number", piNumber],
    ["Date", formatDate(new Date().toISOString())],
    ["Due Date", formatDate(dueDate)],
    ["Period", `${formatDate(periodStart)} – ${formatDate(periodEnd)}`],
  ];
  metaRows.forEach(([label, value]) => {
    doc.setFont("helvetica", "bold");
    doc.text(`${label}:`, marginLeft, y);
    doc.setFont("helvetica", "normal");
    doc.text(value, marginLeft + 35, y);
    y += 5;
  });

  // Billed to
  y += 4;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(BRAND_TEAL[0], BRAND_TEAL[1], BRAND_TEAL[2]);
  doc.text("BILLED TO", marginLeft, y);
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);
  doc.setFont("helvetica", "normal");
  y += 5;
  const billTo = [
    caseData.client_company_name || caseData.client_name,
    caseData.client_company_name ? caseData.client_name : "",
    caseData.client_email || "",
    caseData.client_phone || "",
    caseData.client_gst_number ? `GSTIN: ${caseData.client_gst_number}` : "",
  ].filter(Boolean);
  billTo.forEach((line) => {
    doc.text(line, marginLeft, y);
    y += 5;
  });

  // Line items table
  y += 6;
  const location = caseData.location;
  const locationName = location?.name ?? "The WorkVilla";
  const gstRate = 18;
  // Same helper the billing statement uses — the printed PI and the invoice
  // must never quote different amounts for the same renewal.
  const subtotal = renewalRate(caseData);
  const gstAmount = Math.round(subtotal * gstRate) / 100;
  const cgst = gstAmount / 2;
  const sgst = gstAmount / 2;
  const total = subtotal + gstAmount;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (doc as any).autoTable({
    startY: y,
    head: [["#", "Description", "Amount (Rs.)"]],
    body: [
      [
        "1",
        `Virtual Office License Fee — Renewal\n${locationName}\n${formatDate(periodStart)} to ${formatDate(periodEnd)}`,
        formatCurrency(subtotal),
      ],
    ],
    foot: [
      ["", "CGST @ 9%", formatCurrency(cgst)],
      ["", "SGST @ 9%", formatCurrency(sgst)],
      ["", "Total", formatCurrency(total)],
    ],
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: BRAND_TEAL, textColor: [255, 255, 255] },
    footStyles: { fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 10 }, 2: { halign: "right", cellWidth: 35 } },
    margin: { left: marginLeft, right: marginRight },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let afterTable = (doc as any).lastAutoTable.finalY + 8;

  // Bank details
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(BRAND_TEAL[0], BRAND_TEAL[1], BRAND_TEAL[2]);
  doc.text("PAYMENT OPTIONS", marginLeft, afterTable);
  doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);
  doc.setFont("helvetica", "normal");
  afterTable += 5;

  const bankLines = [
    `Account Name: ${COMPANY_BANK_DETAILS.accountName}`,
    `Bank: ${COMPANY_BANK_DETAILS.bank}  Branch: ${COMPANY_BANK_DETAILS.branch}`,
    `Account No: ${COMPANY_BANK_DETAILS.accountNumber}  IFSC: ${COMPANY_BANK_DETAILS.ifscCode}`,
  ];
  bankLines.forEach((line) => {
    doc.text(line, marginLeft, afterTable);
    afterTable += 5;
  });

  if (razorpayUrl) {
    afterTable += 2;
    doc.setFont("helvetica", "bold");
    doc.text("Online Payment:", marginLeft, afterTable);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 200);
    const shortUrl = razorpayUrl.length > 60 ? razorpayUrl.slice(0, 57) + "…" : razorpayUrl;
    doc.text(shortUrl, marginLeft + 38, afterTable);
    doc.setTextColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);
  }

  addFooter(doc);
  void contentWidth; // used implicitly via autoTable margin

  return Buffer.from(doc.output("arraybuffer"));
}

// ---------------------------------------------------------------------------
// Create a billing statement for a VO renewal
// ---------------------------------------------------------------------------

/**
 * The license fee for the next term.
 *
 * Every agreement's renewal clause promised an escalation while
 * createRenewalBillingStatement billed caseData.rate flat, so each renewal
 * invoice contradicted the executed contract. The escalation is now an agreed
 * per-case figure (migration 00527) and this is the single place it is
 * applied — the renewal notice quotes this same function, so the number in the
 * email and the number on the invoice cannot drift apart.
 *
 * Rounded to whole rupees: a fee of Rs. 18,000 at 5% is Rs. 18,900, not
 * Rs. 18,900.0000001, and part-rupee line items read as errors on an invoice.
 */
export function renewalRate(caseData: {
  rate: number;
  renewal_escalation_percentage?: number | null;
}): number {
  const escalation = caseData.renewal_escalation_percentage ?? 0;
  if (!escalation || escalation <= 0) return caseData.rate;
  return Math.round(caseData.rate * (1 + escalation / 100));
}

export async function createRenewalBillingStatement(params: {
  adminSupabase: SupabaseClient;
  caseData: VoCaseForRenewal;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  piNumber: string;
}): Promise<string> {
  const { adminSupabase, caseData, periodStart, periodEnd, dueDate, piNumber } = params;

  const subtotal = renewalRate(caseData);
  const gstRate = 18;
  const gstAmount = Math.round(subtotal * gstRate) / 100;
  const cgst = gstAmount / 2;
  const sgst = gstAmount / 2;
  const total = subtotal + gstAmount;

  const location = caseData.location;
  const locationName = location?.name ?? "The WorkVilla";

  const { data, error } = await adminSupabase
    .from("billing_statements")
    .insert({
      case_id: caseData.id,
      period_start: periodStart,
      period_end: periodEnd,
      due_date: dueDate,
      statement_type: "vo_renewal",
      fixed_amount: subtotal,
      usage_amount: 0,
      service_usage_amount: 0,
      booking_usage_amount: 0,
      subtotal,
      tax_percentage: gstRate,
      tax_amount: gstAmount,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: 0,
      total_amount: total,
      is_interstate: false,
      place_of_supply: "Tamil Nadu",
      buyer_gstin: caseData.client_gst_number ?? null,
      status: "finalized",
      finalized_at: new Date().toISOString(),
      line_items: [
        {
          type: "prepaid_rent",
          label: "Virtual Office Renewal",
          subtotal,
          items: [
            {
              description: `Virtual Office License Fee — Renewal · ${locationName} · ${formatDate(periodStart)} to ${formatDate(periodEnd)}`,
              quantity: 1,
              rate: subtotal,
              amount: subtotal,
            },
          ],
        },
      ],
      prepaid_month: new Date(periodStart).getMonth() + 1,
      prepaid_year: new Date(periodStart).getFullYear(),
      reference_note: piNumber,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create renewal billing statement: ${error?.message}`);
  }
  return data.id;
}

// ---------------------------------------------------------------------------
// Create Razorpay payment link for a renewal
// ---------------------------------------------------------------------------

export async function createRenewalRazorpayLink(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminSupabase: any;
  caseData: VoCaseForRenewal;
  statementId: string;
  totalAmount: number;
  dueDate: string;
  piNumber: string;
}): Promise<{ id: string; url: string }> {
  const { adminSupabase, caseData, statementId, totalAmount, dueDate, piNumber } = params;

  const settings = await getCachedSettings(adminSupabase, [
    "razorpay_enabled",
    "razorpay_key_id",
    "razorpay_key_secret",
  ]);
  if (!settings.razorpay_enabled || !settings.razorpay_key_id || !settings.razorpay_key_secret) {
    throw new Error("Razorpay is not configured");
  }

  const expireBy = Math.floor(new Date(dueDate).getTime() / 1000) + 86400; // due date + 1 day buffer
  const amountPaise = Math.round(totalAmount * 100);

  const payload = {
    amount: amountPaise,
    currency: "INR",
    description: `VO Renewal — ${piNumber} — ${caseData.client_name} — ${COMPANY_NAME}`,
    reference_id: `VO-${caseData.case_number}-${Date.now()}`,
    expire_by: expireBy,
    notify: { sms: true, email: true },
    reminder_enable: true,
    notes: {
      case_id: caseData.id,
      case_number: caseData.case_number,
      statement_id: statementId,
      type: "vo_renewal",
    },
    customer: {
      name: caseData.client_company_name || caseData.client_name,
      email: caseData.client_email || "",
      contact: caseData.client_phone || "",
    },
  };

  const auth = Buffer.from(
    `${settings.razorpay_key_id}:${settings.razorpay_key_secret}`
  ).toString("base64");

  const res = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Razorpay link creation failed: ${err}`);
  }

  const linkData = await res.json() as Record<string, unknown>;
  return {
    id: String(linkData.id),
    url: String(linkData.short_url),
  };
}

// ---------------------------------------------------------------------------
// Send renewal reminder email
// ---------------------------------------------------------------------------

export async function sendRenewalEmail(params: {
  caseData: VoCaseForRenewal;
  reminderNumber: number;
  isGraceNotice: boolean;
  piNumber: string;
  periodStart: string;
  periodEnd: string;
  totalAmount: number;
  razorpayUrl: string;
  pdfBuffer?: Buffer;
}): Promise<boolean> {
  const { caseData, reminderNumber, isGraceNotice, piNumber, periodStart, periodEnd, totalAmount, razorpayUrl, pdfBuffer } = params;

  if (!caseData.client_email) return false;

  const clientName = caseData.client_company_name || caseData.client_name;
  const location = caseData.location;
  const locationName = location?.name ?? "The WorkVilla";

  let subject: string;
  let urgencyLine: string;

  if (isGraceNotice) {
    subject = `Final Notice — VO Agreement Renewal · ${piNumber} · ${clientName}`;
    urgencyLine = `<p style="color:#dc2626;font-weight:bold;">Your Virtual Office Agreement expired on ${formatDate(caseData.end_date)}. You have a 7-day window to renew and keep your services uninterrupted. After this period the agreement will be lapsed and formal discontinuation procedures will begin.</p>`;
  } else {
    const labels = ["First", "Second", "Third", "Fourth"];
    subject = `${labels[reminderNumber - 1] ?? "Renewal"} Reminder — VO Agreement Renewal · ${piNumber} · ${clientName}`;
    urgencyLine = `<p>This is your <strong>${labels[reminderNumber - 1]?.toLowerCase() ?? "renewal"} reminder</strong> for your Virtual Office Agreement renewal.</p>`;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <div style="background:#0d9488;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0;font-size:18px">${COMPANY_NAME}</h2>
        <p style="color:#ccfbf1;margin:4px 0 0;font-size:13px">Virtual Office Agreement Renewal</p>
      </div>
      <div style="padding:24px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
        <p>Dear ${clientName},</p>
        ${urgencyLine}
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
          <tr style="background:#f0fdf4"><td style="padding:8px 12px;border:1px solid #d1fae5"><strong>PI Number</strong></td><td style="padding:8px 12px;border:1px solid #d1fae5">${piNumber}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e5e7eb"><strong>Location</strong></td><td style="padding:8px 12px;border:1px solid #e5e7eb">${locationName}</td></tr>
          <tr style="background:#f0fdf4"><td style="padding:8px 12px;border:1px solid #d1fae5"><strong>Renewal Period</strong></td><td style="padding:8px 12px;border:1px solid #d1fae5">${formatDate(periodStart)} – ${formatDate(periodEnd)}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e5e7eb"><strong>Amount Due</strong></td><td style="padding:8px 12px;border:1px solid #e5e7eb"><strong>Rs. ${totalAmount.toLocaleString("en-IN")} (incl. GST)</strong></td></tr>
        </table>
        <div style="text-align:center;margin:24px 0">
          <a href="${razorpayUrl}" style="background:#0d9488;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px">Pay Now Online →</a>
        </div>
        <p style="font-size:13px;color:#6b7280">You can also pay via bank transfer:</p>
        <p style="font-size:12px;color:#374151;background:#f9fafb;padding:12px;border-radius:4px">
          ${Object.entries(COMPANY_BANK_DETAILS ?? {}).map(([k, v]) => `${k}: ${v}`).join(" &nbsp;|&nbsp; ")}
        </p>
        <p style="font-size:12px;color:#9ca3af;margin-top:20px">If you have already made the payment, please ignore this reminder or contact our accounts team at billing@theworkvilla.com</p>
      </div>
    </div>
  `;

  const attachments = pdfBuffer
    ? [{ filename: `${piNumber}.pdf`, content: pdfBuffer.toString("base64") }]
    : [];

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [caseData.client_email],
      bcc: ["billing@theworkvilla.com"],
      subject,
      html,
      attachments,
    });
    return true;
  } catch (err) {
    console.error("[vo-renewal] Email send failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Send renewal reminder via WhatsApp
// ---------------------------------------------------------------------------

/**
 * Sends the renewal proforma over WhatsApp using the approved `gst_invoice_doc`
 * template ("Hi {{1}}, invoice {{2}} of Rs.{{3}} from The Work Villa is
 * attached. Click to pay: {{4}}."), which matches this message exactly.
 *
 * This previously used `vo_renewal_reminder` / `vo_renewal_final_notice`. Neither
 * was ever registered in MSG91, so every send failed with "template name does
 * not exist in en" — VO renewal reminders have never gone out over WhatsApp.
 *
 * `gst_invoice_doc` has a document header, so the PI PDF must be uploaded and
 * signed first. Callers already generate this buffer for the email attachment.
 * Note the approved template carries no "final notice" wording, so the grace
 * notice reads the same as the first reminder on WhatsApp; the escalation is
 * still conveyed by the email.
 */
export async function sendRenewalWhatsApp(params: {
  caseData: VoCaseForRenewal;
  isGraceNotice: boolean;
  piNumber: string;
  totalAmount: number;
  razorpayUrl: string;
  pdfBuffer?: Buffer;
  supabase: SupabaseClient;
}): Promise<boolean> {
  const { caseData, piNumber, totalAmount, razorpayUrl, pdfBuffer, supabase } = params;
  if (!caseData.client_phone) return false;

  if (!pdfBuffer) {
    console.warn(`[vo-renewal] No PI PDF for ${piNumber} — WhatsApp renewal skipped.`);
    return false;
  }

  const clientName = caseData.client_company_name || caseData.client_name;

  try {
    const storagePath = `vo-renewals/${caseData.id}/${piNumber.replace(/\//g, "-")}.pdf`;
    await supabase.storage
      .from("crm-documents")
      .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

    const { data: signed } = await supabase.storage
      .from("crm-documents")
      .createSignedUrl(storagePath, 365 * 24 * 3600);

    const pdfUrl = signed?.signedUrl;
    if (!pdfUrl) {
      console.error(`[vo-renewal] Could not sign PI PDF URL for ${piNumber} — WhatsApp skipped.`);
      return false;
    }

    // Back on messaging.invoiceDocument() now that it takes the entity type
    // explicitly. It previously hardcoded "proposal", which would have broken
    // the delivery webhook's lead lookup for a VO case, so this call was
    // hand-rolled to get the tag right.
    const result = await messaging.invoiceDocument(
      caseData.client_phone,
      clientName,
      piNumber,
      // Template renders "Rs.{{3}}", so pass the bare number — the old code
      // passed "Rs. 12,000" here, which would have rendered "Rs.Rs. 12,000".
      totalAmount.toLocaleString("en-IN"),
      razorpayUrl,
      pdfUrl,
      { type: "case", id: caseData.id },
    );
    return result.success;
  } catch (err) {
    console.error("[vo-renewal] WhatsApp send failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Log a renewal reminder row
// ---------------------------------------------------------------------------

export async function logRenewalReminder(params: {
  adminSupabase: SupabaseClient;
  caseId: string;
  reminderNumber: number;
  statementId: string;
  razorpayLinkId: string;
  razorpayLinkUrl: string;
  emailSent: boolean;
  whatsAppSent: boolean;
  isGraceNotice: boolean;
}): Promise<void> {
  const { adminSupabase, ...row } = params;
  await adminSupabase.from("vo_renewal_reminders").insert({
    case_id: row.caseId,
    reminder_number: row.reminderNumber,
    billing_statement_id: row.statementId,
    razorpay_link_id: row.razorpayLinkId,
    razorpay_link_url: row.razorpayLinkUrl,
    email_sent: row.emailSent,
    whatsapp_sent: row.whatsAppSent,
    is_grace_notice: row.isGraceNotice,
  });
}

// ---------------------------------------------------------------------------
// Handle a successful renewal payment (called from webhook)
// ---------------------------------------------------------------------------

export async function handleRenewalPayment(params: {
  adminSupabase: SupabaseClient;
  caseId: string;
  statementId: string;
  amountPaid: number;
  razorpayPaymentId: string;
  razorpayLinkId: string;
}): Promise<void> {
  const { adminSupabase, caseId, statementId, amountPaid, razorpayPaymentId, razorpayLinkId } = params;

  // Fetch current case to know tenure_months and end_date
  const { data: caseData } = await adminSupabase
    .from("cases")
    .select("end_date, tenure_months, start_date, renewal_reminder_count")
    .eq("id", caseId)
    .single();

  if (!caseData) throw new Error("Case not found for renewal payment");

  // Mark billing statement paid
  await adminSupabase
    .from("billing_statements")
    .update({
      payment_status: "paid",
      payment_received_at: new Date().toISOString(),
      payment_reference: razorpayPaymentId,
      razorpay_payment_link_id: razorpayLinkId,
    })
    .eq("id", statementId);

  // Advance the end_date by tenure_months
  const currentEnd = new Date(caseData.end_date);
  const tenureMonths = caseData.tenure_months || 12;
  const newStart = new Date(currentEnd);
  newStart.setDate(newStart.getDate() + 1);
  const newEnd = new Date(currentEnd);
  newEnd.setMonth(newEnd.getMonth() + tenureMonths);

  // Update case: back to active for the new term, clear renewal tracking
  await adminSupabase
    .from("cases")
    .update({
      status: "active",
      start_date: newStart.toISOString().split("T")[0],
      end_date: newEnd.toISOString().split("T")[0],
      renewal_billing_statement_id: null,
      renewal_razorpay_link_id: null,
      renewal_razorpay_link_url: null,
      renewal_grace_ends_at: null,
      renewal_reminder_count: 0,
    })
    .eq("id", caseId);

  logAudit(adminSupabase, {
    entityType: "case",
    entityId: caseId,
    action: "update",
    performedBy: "system",
    changes: {
      action: { old: null, new: "renewal_payment_received" },
      amount: { old: null, new: amountPaid },
      new_end_date: { old: caseData.end_date, new: newEnd.toISOString().split("T")[0] },
    },
  });
}

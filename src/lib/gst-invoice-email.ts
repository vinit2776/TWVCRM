import { COMPANY_BANK_DETAILS } from "@/lib/constants";

/**
 * The email a customer gets when a GST tax invoice is (re)sent from the Tally
 * Inbox. One builder feeds both the resend route and the confirmation preview
 * in the upload form, so what accounts is shown is what the customer receives.
 */
export function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface GstInvoiceEmailInput {
  partyName: string;
  invoiceNumber: string;
  /** Already formatted, e.g. "₹1,68,951". */
  totalDisplay: string;
  contractNumber: string;
  /** Statement already paid: the email is a receipt copy with no payment ask. */
  isReceipt: boolean;
  /** Replaces an invoice file the customer was already emailed: says to ignore the earlier attachment. */
  isReplacement?: boolean;
}

export function gstInvoiceFilename(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^\w-]/g, "_")}.pdf`;
}

export function buildGstInvoiceEmail(input: GstInvoiceEmailInput): { subject: string; html: string } {
  const i = { ...input, partyName: escapeHtml(input.partyName) };
  const base = i.isReceipt
    ? `GST tax invoice ${i.invoiceNumber} — receipt`
    : `GST tax invoice ${i.invoiceNumber} — ${i.totalDisplay} due`;
  const subject = i.isReplacement ? `Corrected: ${base}` : base;

  const replacementNote = i.isReplacement
    ? `<p><strong>Please ignore the attachment in our previous email for this invoice — it was sent by a system error. The attachment in this email is the correct one.</strong></p>
       `
    : "";

  const html = i.isReceipt
    ? `<p>Dear ${i.partyName},</p>
       ${replacementNote}<p>Please find attached your GST tax invoice <strong>${i.invoiceNumber}</strong> for <strong>${i.totalDisplay}</strong> against contract ${i.contractNumber}.</p>
       <p>This invoice is for your records. No further action is required.</p>
       <p>Regards,<br/>The WorkVilla — Accounts</p>`
    : `<p>Dear ${i.partyName},</p>
       ${replacementNote}<p>Please find attached your GST tax invoice <strong>${i.invoiceNumber}</strong> for <strong>${i.totalDisplay}</strong> against contract ${i.contractNumber}.</p>
       <p>Kindly arrange payment at the earliest. If a payment link is needed, please reply to this email and we will share one promptly.</p>
       <p>Regards,<br/>The WorkVilla — Accounts</p>`;

  return { subject, html };
}

// ── Inbox "Send" email (inbox-send route) ────────────────────────────────────
export interface InboxSendEmailInput extends GstInvoiceEmailInput {
  /** Existing or freshly created Razorpay link; null when there is none. */
  payLinkUrl: string | null;
}

export function buildInboxSendEmail(i: InboxSendEmailInput): { subject: string; html: string } {
  const partyName = escapeHtml(i.partyName);
  const subject = i.isReceipt
    ? `GST tax invoice ${i.invoiceNumber} — receipt`
    : `GST tax invoice ${i.invoiceNumber} — ${i.totalDisplay} due`;
  const html = i.isReceipt
    ? `
      <p>Dear ${partyName},</p>
      <p>Thank you for your payment. Please find attached the GST tax invoice
         <strong>${i.invoiceNumber}</strong> for <strong>${i.totalDisplay}</strong>,
         as recorded against contract ${i.contractNumber}.</p>
      <p>This invoice is for your records. No further action is required.</p>
      <p>Regards,<br/>The WorkVilla — Accounts</p>
    `
    : `
      <p>Dear ${partyName},</p>
      <p>Please find attached the GST tax invoice <strong>${i.invoiceNumber}</strong>
         for <strong>${i.totalDisplay}</strong>, against contract ${i.contractNumber}.</p>
      ${i.payLinkUrl ? `<p>Pay online: <a href="${i.payLinkUrl}">${i.payLinkUrl}</a></p>` : "<p>Kindly arrange payment at the earliest.</p>"}
      <p>Regards,<br/>The WorkVilla — Accounts</p>
    `;
  return { subject, html };
}

// ── Email sent straight from an unpaid GST upload (upload-gst-invoice route) ─
export interface UploadEmailInput {
  customerName: string;
  /** Null when the statement has no billing period (e.g. a reimbursement): the period lines are left out. */
  periodLabel: string | null;
  invoiceNumber: string;
  /** "Contract" | "Proposal Ref" | "Invoice" */
  refLabel: string;
  contractNumber: string;
  invoiceDateFormatted: string;
  amountFormatted: string;
  payLinkUrl: string | null;
  upiId?: string;
}

export function buildUploadEmail(i: UploadEmailInput): { subject: string; html: string } {
  const customerName = escapeHtml(i.customerName);
  const html = `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Tax Invoice</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">Please find attached your GST tax invoice${i.periodLabel ? ` for <strong>${i.periodLabel}</strong>` : ""}. Kindly make payment at your earliest convenience.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
              <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${i.invoiceNumber}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">${i.refLabel}</td><td style="padding:6px 0;">${i.contractNumber}</td></tr>
              ${i.periodLabel ? `<tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${i.periodLabel}</td></tr>` : ""}
              <tr><td style="padding:6px 0;color:#666;">Invoice Date</td><td style="padding:6px 0;">${i.invoiceDateFormatted}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${i.amountFormatted}</td></tr>
            </table>
            ${i.payLinkUrl ? `
            <h3 style="color:#015E65;font-size:14px;margin:20px 0 10px;">Payment Options</h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <tr><td style="padding:4px 0;color:#666;">Bank Transfer</td><td style="padding:4px 0;">${COMPANY_BANK_DETAILS.accountName}<br/>${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>A/C: ${COMPANY_BANK_DETAILS.accountNumber} | IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
              ${i.upiId ? `<tr><td style="padding:4px 0;color:#666;">UPI</td><td style="padding:4px 0;">${i.upiId}</td></tr>` : ""}
              <tr><td style="padding:4px 0;color:#666;">Pay Online</td><td style="padding:4px 0;"><a href="${i.payLinkUrl}" style="color:#015E65;font-weight:bold;">${i.payLinkUrl}</a></td></tr>
            </table>
            <div style="text-align:center;margin:24px 0;">
              <a href="${i.payLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
            </div>
            ` : ""}
            <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
          </div>
        </div>
      `;
  return { subject: `Tax Invoice ${i.invoiceNumber} — ${i.contractNumber} — The WorkVilla`, html };
}

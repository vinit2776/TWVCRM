/**
 * The email a customer gets when a GST tax invoice is (re)sent from the Tally
 * Inbox. One builder feeds both the resend route and the confirmation preview
 * in the upload form, so what accounts is shown is what the customer receives.
 */
export interface GstInvoiceEmailInput {
  partyName: string;
  invoiceNumber: string;
  /** Already formatted, e.g. "₹1,68,951". */
  totalDisplay: string;
  contractNumber: string;
  /** Statement already paid: the email is a receipt copy with no payment ask. */
  isReceipt: boolean;
}

export function gstInvoiceFilename(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^\w-]/g, "_")}.pdf`;
}

export function buildGstInvoiceEmail(i: GstInvoiceEmailInput): { subject: string; html: string } {
  const subject = i.isReceipt
    ? `GST tax invoice ${i.invoiceNumber} — receipt`
    : `GST tax invoice ${i.invoiceNumber} — ${i.totalDisplay} due`;

  const html = i.isReceipt
    ? `<p>Dear ${i.partyName},</p>
       <p>Please find attached your GST tax invoice <strong>${i.invoiceNumber}</strong> for <strong>${i.totalDisplay}</strong> against contract ${i.contractNumber}.</p>
       <p>This invoice is for your records. No further action is required.</p>
       <p>Regards,<br/>The WorkVilla — Accounts</p>`
    : `<p>Dear ${i.partyName},</p>
       <p>Please find attached your GST tax invoice <strong>${i.invoiceNumber}</strong> for <strong>${i.totalDisplay}</strong> against contract ${i.contractNumber}.</p>
       <p>Kindly arrange payment at the earliest. If a payment link is needed, please reply to this email and we will share one promptly.</p>
       <p>Regards,<br/>The WorkVilla — Accounts</p>`;

  return { subject, html };
}

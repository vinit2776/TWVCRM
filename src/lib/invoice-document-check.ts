/**
 * First gate on a GST invoice upload: is this file a tax invoice at all, or some
 * other document (agreement, receipt, bank slip, a different bill)? It runs
 * before the name / GSTIN / period checks, which only make sense for an invoice.
 *
 * Tally prints the invoice number as SD/A|B/yy-yy/n and the words "Tax Invoice".
 * A readable PDF with neither is not one of our invoices. Credit notes and
 * proformas carry "Tax Invoice"-free titles, so they are rejected too.
 */
const TALLY_INVOICE_NUMBER = /SD\/(?:A|B)\/\d{2}-\d{2}\/\d+/i;
const TAX_INVOICE_TITLE = /\btax\s+invoice\b/i;
const NOT_A_TAX_INVOICE = /\b(?:credit\s+note|debit\s+note|proforma|pro-forma|quotation|receipt\s+voucher|payment\s+receipt)\b/i;

/** True when the text reads as a tax invoice; null when there is no text to judge. */
export function looksLikeTaxInvoice(text: string): boolean | null {
  if (!text.trim()) return null;
  if (TALLY_INVOICE_NUMBER.test(text)) return true;
  if (TAX_INVOICE_TITLE.test(text) && !NOT_A_TAX_INVOICE.test(text)) return true;
  return false;
}

/**
 * Whole-rupee total for an ad-hoc invoice.
 *
 * Billing statements settle on the whole-rupee amount (see settlementAmount in
 * settlement.ts): a statement for ₹10,001.68 needs ₹10,002 to read "paid". The
 * invoice's Razorpay link and the statement mirrored from it both take their
 * amount from proforma_invoices.total_amount, so if that keeps the paise a
 * customer who pays the link in full leaves the statement ₹0.32 short — it
 * sticks on "partially_paid" and the invoice never flips to "paid" (INV-0060).
 * Rounding here makes the link, the statement and the settlement rule agree.
 */
export function adhocInvoiceTotal(subtotal: number, taxAmount: number, discountAmount = 0): number {
  return Math.round(subtotal + taxAmount - discountAmount);
}

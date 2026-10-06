/**
 * Maps a Razorpay payment-link response to the proforma_invoices date columns.
 * Razorpay returns unix seconds; both are the gateway's own values, not ours,
 * so the CRM shows exactly what the customer's link will do.
 */
export function razorpayLinkDates(link: { created_at?: number; expire_by?: number }) {
  return {
    razorpay_link_created_at: link.created_at ? new Date(link.created_at * 1000).toISOString() : null,
    razorpay_link_expires_at: link.expire_by ? new Date(link.expire_by * 1000).toISOString() : null,
  };
}

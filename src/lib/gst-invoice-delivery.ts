/**
 * Has this statement's GST invoice actually been emailed to the customer?
 *
 * `tally_delivered_at` is NOT the answer: the Tally bridge stamps it when it
 * acknowledges an invoice (dispatch-tally-invoice), whether or not the customer
 * email went out. Treating it as proof is how failed sends ended up marked
 * Complete with the customer never receiving the invoice. Only an emailed
 * timestamp or a 'sent' send-log row counts.
 */
export function wasCustomerEmailed(args: {
  emailed_at: string | null;
  gst_invoice_sent_at: string | null;
  sentLogCount: number;
}): boolean {
  return !!(args.emailed_at || args.gst_invoice_sent_at) || args.sentLogCount > 0;
}

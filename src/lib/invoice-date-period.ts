/**
 * A tax invoice dated outside the billing period's months (e.g. a November
 * invoice for an October rent cycle) is usually a slip — or a late invoice
 * accounts should consciously own, since the date drives GST filing. Shared
 * by the Tally upload form (warn) and the upload route (enforce the tick).
 *
 * Compared by calendar month, in the YYYY-MM-DD strings as stored — no
 * timezone maths, so an invoice on the 1st can't slide into the wrong month.
 */
export function isInvoiceDateOffPeriod(
  invoiceDate: string | null | undefined,
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
): boolean {
  if (!invoiceDate || !periodStart || !periodEnd) return false;
  const month = (d: string) => d.slice(0, 7);
  const m = month(invoiceDate);
  return m < month(periodStart) || m > month(periodEnd);
}

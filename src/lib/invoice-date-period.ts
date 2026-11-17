/**
 * A tax invoice dated outside the month it should be billed in (e.g. a
 * November invoice for an October rent cycle) is usually a slip — or a late
 * invoice accounts should consciously own, since the date drives GST filing.
 * Shared by the Tally upload form (warn) and the upload route (enforce the tick).
 *
 * Rent is billed in advance (the cron generates next month's statement at
 * month-end), so the month before the period starts is fine; anything earlier,
 * or after the period's last month, is off.
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
  const monthBefore = (d: string) => {
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(5, 7));
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  };
  const m = month(invoiceDate);
  return m < monthBefore(periodStart) || m > month(periodEnd);
}

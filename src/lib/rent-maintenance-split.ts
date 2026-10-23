/**
 * Rent / maintenance split for invoice lines.
 *
 * A contract's line items may mark a component as fixed (`escalates: false`),
 * e.g. maintenance. Invoices show that component as its own line. The split is
 * only a presentation of the SAME rent amount: rent + maintenance always add
 * back to the original amount to the paisa, so subtotal, GST and total are
 * never affected.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface SplittableItem {
  total: number;
  escalates?: boolean;
}

/**
 * Fraction (0..1, exclusive) of the monthly rate that is a fixed component, or
 * 0 when the contract has no split (no fixed line, or every line is fixed).
 */
export function fixedShareOfItems(items: SplittableItem[] | null | undefined): number {
  if (!items || items.length === 0) return 0;
  const total = items.reduce((s, i) => s + (Number(i.total) || 0), 0);
  const fixed = items.filter((i) => i.escalates === false).reduce((s, i) => s + (Number(i.total) || 0), 0);
  if (total <= 0 || fixed <= 0 || fixed >= total) return 0;
  return fixed / total;
}

/** Splits `amount` into rent and maintenance; the two always sum to `amount`. */
export function splitByShare(amount: number, share: number): { rent: number; maintenance: number } {
  if (!(share > 0) || !(share < 1)) return { rent: amount, maintenance: 0 };
  const maintenance = round2(amount * share);
  return { rent: round2(amount - maintenance), maintenance };
}

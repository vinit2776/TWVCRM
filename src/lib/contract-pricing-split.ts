import type { LineItem } from "@/types";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PricingTotals {
  items: LineItem[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
}

/** Recomputes every line total and the contract totals from unit prices. */
export function computePricingTotals(
  lines: Array<Omit<LineItem, "total">>,
  taxPercentage: number,
  discountPercentage: number
): PricingTotals {
  const items = lines.map((l) => ({ ...l, total: round2(l.quantity * l.unit_price) }));
  const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
  const discountAmount = round2(subtotal * (discountPercentage / 100));
  const taxable = subtotal - discountAmount;
  const taxAmount = round2(taxable * (taxPercentage / 100));
  return { items, subtotal, discountAmount, taxAmount, totalAmount: round2(taxable + taxAmount) };
}

/**
 * Moves the outstanding deposit shortfall by the change in monthly subtotal.
 * Adjusting by the delta (rather than recomputing from the parent) keeps any
 * top-up already paid against the shortfall intact.
 */
export function adjustDepositShortfall(
  oldShortfall: number,
  oldSubtotal: number,
  newSubtotal: number,
  depositMonths: number
): number {
  return Math.max(0, round2(oldShortfall + (newSubtotal - oldSubtotal) * depositMonths));
}

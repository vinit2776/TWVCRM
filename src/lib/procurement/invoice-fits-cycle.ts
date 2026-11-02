/** GST slabs a vendor invoice can carry on top of a PO's pre-GST cycle cost. */
export const GST_SLABS = [5, 12, 18, 28] as const;

/** Vendors round the GST-inclusive total to the rupee (PO-2604-047: ₹15,611 against 13,230 + 18% = 15,611.40). */
export const GST_ROUNDING_TOLERANCE = 1;

const round2 = (n: number) => Math.round(n * 100) / 100;

export type InvoiceCycleFit =
  | { fits: true; basis: "base" | "gst_inclusive"; gstRate: number | null }
  | { fits: false };

/**
 * Does a vendor invoice fit one cycle of an AMC? POs are raised before GST, but
 * vendors such as Blue Star bill each instalment with GST on top (a ₹20,790 PO paid
 * half-yearly is invoiced as ₹10,395 + 18% = ₹12,266.10). Comparing the invoice total
 * straight to the cycle cost rejects exactly those invoices, so an invoice also fits
 * when its total is the cycle cost plus a standard GST slab.
 */
export function invoiceFitsCycle(
  bill: { total_amount: number | string; base_amount?: number | string | null },
  unitCost: number,
): InvoiceCycleFit {
  const total = Number(bill.total_amount);
  // base_amount is 0 on rows written before GST was tracked; that means "unset", not free.
  const recorded = bill.base_amount == null ? 0 : Number(bill.base_amount);
  const base = recorded > 0 ? recorded : total;
  // Pre-GST amount fits (the bill's recorded base, or its total when no GST was recorded).
  if (base <= unitCost + 0.01) return { fits: true, basis: "base", gstRate: null };
  for (const rate of GST_SLABS) {
    if (Math.abs(total - round2(unitCost * (1 + rate / 100))) <= GST_ROUNDING_TOLERANCE) {
      return { fits: true, basis: "gst_inclusive", gstRate: rate };
    }
  }
  return { fits: false };
}

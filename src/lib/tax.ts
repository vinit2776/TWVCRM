/**
 * GST tax calculation — The WorkVilla
 *
 * BUSINESS RULE (do not override without management sign-off):
 *   All services are rendered at The WorkVilla's facilities in Tamil Nadu.
 *   Tax is ALWAYS intra-state → CGST + SGST only.
 *   IGST never applies — TWV does not supply to other states.
 *
 * All billing, proforma, and invoice calculations must use `calcGst()` from
 * this file. Never introduce `isInterstate` branching or IGST logic elsewhere.
 * If a genuinely interstate supply ever arises in the future, update this file
 * and this comment — do not scatter the logic across features.
 */

export interface GstBreakdown {
  subtotal:   number; // ex-GST amount passed in
  taxRate:    number; // e.g. 18 (%)
  taxAmount:  number; // total GST (cgst + sgst)
  cgst:       number; // taxAmount / 2
  sgst:       number; // taxAmount / 2
  igst:       number; // always 0 — TWV is intra-state Tamil Nadu only
  grandTotal: number; // subtotal + taxAmount
}

/**
 * Calculate GST for a billable amount.
 *
 * Always returns an intra-state CGST + SGST breakdown.
 * `igst` in the returned object is always 0.
 *
 * @param subtotal  Ex-GST amount in rupees (may be fractional before rounding)
 * @param taxRate   Percentage, e.g. 18 for 18 % GST
 */
export function calcGst(subtotal: number, taxRate: number): GstBreakdown {
  const taxAmount  = parseFloat((subtotal * taxRate / 100).toFixed(2));
  const half       = parseFloat((taxAmount / 2).toFixed(2));
  return {
    subtotal,
    taxRate,
    taxAmount,
    cgst:       half,
    sgst:       half,
    igst:       0,       // intra-state Tamil Nadu — IGST never applies
    grandTotal: parseFloat((subtotal + taxAmount).toFixed(2)),
  };
}

/**
 * Integer-paise GST computation with rupee rounding.
 *
 * All arithmetic uses integer paise internally to eliminate float drift.
 * When total tax paise is odd, sgst absorbs the extra paisa.
 * roundOff bridges exact-paise total and the nearest-rupee grand total.
 */

export interface GstResult {
  /** CGST in rupees (may have paise, e.g. 9.09) */
  cgst: number;
  /** SGST in rupees */
  sgst: number;
  /** Always 0 — all TWV services are intra-state */
  igst: number;
  /** cgst + sgst, in rupees */
  taxAmount: number;
  /** Grand total rounded to nearest rupee */
  totalAmount: number;
  /**
   * Round-off adjustment in rupees: totalAmount − (subtotal + taxAmount).
   * Typically ±₹0.00–₹0.99. Negative means the total was rounded down.
   * Surface as an explicit line item on EB invoices (F1).
   */
  roundOff: number;
}

/**
 * Compute GST (CGST + SGST) for an intra-state invoice.
 *
 * @param subtotalRupees - Pre-tax subtotal; may carry paise (e.g. 44104.80)
 * @param taxPercentage  - Tax rate as a whole-number percent (e.g. 18)
 */
export function computeGstAndRounding(
  subtotalRupees: number,
  taxPercentage: number,
): GstResult {
  const subtotalPaise = Math.round(subtotalRupees * 100);
  const taxPaise = Math.round((subtotalPaise * taxPercentage) / 100);
  const cgstPaise = Math.floor(taxPaise / 2);
  const sgstPaise = taxPaise - cgstPaise; // absorbs odd paise
  const exactTotalPaise = subtotalPaise + taxPaise;
  const roundedTotalPaise = Math.round(exactTotalPaise / 100) * 100;
  const roundOffPaise = roundedTotalPaise - exactTotalPaise;

  return {
    cgst: cgstPaise / 100,
    sgst: sgstPaise / 100,
    igst: 0,
    taxAmount: taxPaise / 100,
    totalAmount: roundedTotalPaise / 100,
    roundOff: roundOffPaise / 100,
  };
}

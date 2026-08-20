/**
 * Shared helpers for resolving line item fields from billing_statements.line_items JSONB.
 *
 * Different section types historically stored the billable quantity under different keys:
 *   ad_hoc_charges  → quantity
 *   facility_usage  → billable  (legacy) / qty (canonical, added Jun 2026)
 *   service_usage   → overage   (legacy) / qty (canonical, added Jun 2026)
 *   booking_usage   → qty
 *
 * New statements always set `qty` and `unit_price` at source (billing.ts). These helpers
 * remain for backwards compatibility with statements generated before Jun 2026.
 *
 * ALL callers must use resolveLineItemQty / resolveLineItemRate — never inline the fallback
 * chain. That way a future field rename only requires one edit here, not N files.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LineItem = Record<string, any>;

export function resolveLineItemQty(item: LineItem, context?: string): number {
  const val = item.qty ?? item.quantity ?? item.billable ?? item.overage;
  if (val == null) {
    console.warn(
      `[billing-pdf-utils${context ? `:${context}` : ""}] line item missing qty field — defaulting to 1:`,
      JSON.stringify(item)
    );
  }
  return Number(val ?? 1);
}

export function resolveLineItemRate(item: LineItem): number {
  return Number(item.unit_price || item.rate || item.amount || 0);
}

/**
 * Appends a pro-rata calculation sub-line to a line item's description when the
 * item was prorated at generation time (contract ending before month-end).
 * `monthly_rate` / `days_used` / `days_in_month` are stashed on the item by
 * billing.ts at generation time — never recomputed from the contract's CURRENT
 * rate here, since a rate-phase change after generation would otherwise make
 * old statements display the wrong historical rate.
 */
export function withProrationBreakdown(description: string, item: LineItem): string {
  const { monthly_rate: monthlyRate, days_used: daysUsed, days_in_month: daysInMonth } = item;
  if (monthlyRate == null || daysUsed == null || daysInMonth == null) return description;
  const fmt = (n: number) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return `${description}\nMonthly Rate: Rs. ${fmt(monthlyRate)} | Days: ${daysUsed}`;
}

/**
 * Decimal places to show for a line item's unit rate.
 *
 * Rent lines derive their per-seat rate by dividing the line amount by the seat
 * count (billing.ts, buildProratedRentLineItems). When that division is not
 * exact, a rate printed at the usual 2 dp no longer multiplies back to the
 * amount — a customer checking `Qty x Rate` against the Total sees a few paise
 * of drift (see issue #498: 8 x 11,055.63 = 88,445.04 against an amount of
 * 88,445).
 *
 * The amount is authoritative and must not change, so the fix is on the display
 * side: widen the rate just enough that the multiplication reconciles at paise
 * precision. 2 dp is kept wherever it already works, which is the overwhelming
 * majority of lines, so invoices do not suddenly grow decimal places.
 *
 * Non-terminating cases (19,145 / 3) never reconcile exactly at any finite
 * precision, but a few extra places put the residual below half a paisa, so it
 * disappears once the customer rounds — 3 x 6,381.667 = 19,145.001. The ceiling
 * is 5 dp because the residual scales with quantity: a 143-seat line needs
 * ~3.5e-5 of rate precision to stay inside a paisa, which 4 dp cannot give.
 *
 * This cannot repair statements generated before the rate was stored at full
 * precision — those persisted an already-rounded 2 dp rate, so the information
 * needed to reconcile is gone from the record. Current billing.ts stores the
 * undivided quotient, so newly generated statements are unaffected.
 */
export function rateDecimalsForLine(qty: number, rate: number, amount: number): number {
  const MIN = 2, MAX = 5;
  if (!Number.isFinite(qty) || !Number.isFinite(rate) || !Number.isFinite(amount)) return MIN;
  if (qty <= 0) return MIN;

  for (let dp = MIN; dp <= MAX; dp++) {
    const shown = Number(rate.toFixed(dp));
    // Reconciles if the printed rate times qty agrees with the amount to the paisa.
    if (Math.abs(shown * qty - amount) < 0.005) return dp;
  }
  return MAX;
}

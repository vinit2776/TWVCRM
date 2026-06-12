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

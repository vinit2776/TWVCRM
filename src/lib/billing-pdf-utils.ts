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

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-20" → "20 Aug 2026"; anything else → null (caller falls back). */
function formatYmdLong(ymd: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ""));
  if (!m) return null;
  const month = MONTH_SHORT[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

/**
 * Appends a pro-rata calculation sub-line to a line item's description when the
 * item was prorated at generation time (contract starting/ending mid-month,
 * rate change inside the month).
 * `monthly_rate` / `days_used` / `days_in_month` are stashed on the item by
 * billing.ts at generation time — never recomputed from the contract's CURRENT
 * rate here, since a rate-phase change after generation would otherwise make
 * old statements display the wrong historical rate.
 *
 * A full month reads "full month" with the dates; a part month shows the days.
 * Items that also carry `period_start` / `period_end` (every pro-rata line
 * generated since Nov 2026) get the customer-facing wording: the overall monthly
 * rent (never a per-seat figure), the exact dates counted and the working.
 * Older items have no dates and keep the original two-fact sub-line, so
 * statements already sent re-render exactly as before.
 */
export function withProrationBreakdown(description: string, item: LineItem): string {
  const { monthly_rate: monthlyRate, days_used: daysUsed, days_in_month: daysInMonth } = item;
  if (monthlyRate == null || daysUsed == null || daysInMonth == null) return description;
  const fmt = (n: number) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

  const from = formatYmdLong(item.period_start);
  const to = formatYmdLong(item.period_end);
  if (!from || !to) {
    return `${description}\nMonthly Rate: Rs. ${fmt(monthlyRate)} | Days: ${daysUsed}`;
  }

  const isRent = /^(Monthly rent|Pro-Rata Workspace Fee)/i.test(description);
  const rateLabel = isRent ? "Monthly rent" : "Monthly charge";
  if (Number(daysUsed) >= Number(daysInMonth)) {
    return `${description}\n${rateLabel}: Rs. ${fmt(monthlyRate)} (full month, ${from} to ${to})`;
  }
  const lines = [
    description,
    `${rateLabel}: Rs. ${fmt(monthlyRate)}`,
    `Pro-rata: ${daysUsed} of ${daysInMonth} days (${from} to ${to}, both dates included)`,
  ];
  // Show the working only when it really reproduces the amount, so a
  // hand-adjusted line never prints a sum that doesn't add up.
  const amount = Number(item.amount);
  if (Number.isFinite(amount) && Math.abs((Number(monthlyRate) * daysUsed) / daysInMonth - amount) < 1) {
    lines.push(`Rs. ${fmt(monthlyRate)} \u00d7 ${daysUsed} \u00f7 ${daysInMonth} = Rs. ${fmt(amount)}`);
  }
  return lines.join("\n");
}

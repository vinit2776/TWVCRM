export type PaymentBatchType = "immediate" | "15th" | "25th";

/**
 * Compute the actual calendar date for a payment batch type.
 *
 * - immediate → today
 * - 15th → next upcoming 15th (if today >= 15, moves to next month)
 * - 25th → next upcoming 25th (if today >= 25, moves to next month)
 *
 * Past dates are always blocked — the result is always today or in the future.
 */
export function computeBatchDate(type: PaymentBatchType, referenceDate?: Date): Date {
  const today = new Date(referenceDate ?? new Date());
  today.setHours(0, 0, 0, 0);

  if (type === "immediate") return today;

  const targetDay = type === "15th" ? 15 : 25;
  const candidate = new Date(today.getFullYear(), today.getMonth(), targetDay);
  candidate.setHours(0, 0, 0, 0);

  // If the candidate is strictly in the past, roll forward to next month
  if (candidate < today) {
    return new Date(today.getFullYear(), today.getMonth() + 1, targetDay);
  }
  return candidate;
}

/** Format a date as "15 May 2026" */
export function formatBatchDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

/** Returns true if the ISO date string is today */
export function isBatchToday(batchDate: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(batchDate + "T00:00:00");
  d.setHours(0, 0, 0, 0);
  return d.getTime() === today.getTime();
}

/** Returns true if the ISO date string is tomorrow */
export function isBatchTomorrow(batchDate: string): boolean {
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const d = new Date(batchDate + "T00:00:00");
  d.setHours(0, 0, 0, 0);
  return d.getTime() === tomorrow.getTime();
}

/** Short human-readable label: "Today", "Tomorrow", or "15 May 2026" */
export function batchDateLabel(batchDate: string): string {
  if (isBatchToday(batchDate)) return "Today";
  if (isBatchTomorrow(batchDate)) return "Tomorrow";
  return formatBatchDate(batchDate);
}

/** Serialize a Date to YYYY-MM-DD (for DB / API payloads) */
export function toISODateString(d: Date): string {
  return d.toISOString().split("T")[0];
}

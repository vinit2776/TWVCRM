/**
 * The two dates on a customer payment, kept distinct:
 *
 *   payment_date — when the money reached our bank account. Typed by the person
 *                  recording it, read off the bank statement.
 *   created_at   — when the payment was entered into the CRM. Set by the
 *                  database; never typed.
 *
 * They are routinely days apart, and a screen that shows only one (or calls the
 * bank date "Date recorded", as one panel did) makes a payment look like it was
 * entered when it was received.
 */

const IST = "Asia/Kolkata";

/** Today as YYYY-MM-DD in India, regardless of the browser's or server's zone. */
export function todayIst(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: IST });
}

/** A bank date later than today (IST) is a typo, not a payment. */
export function isFutureDate(ymd: string, now: Date = new Date()): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd > todayIst(now);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Thu, 1 Oct 2026" from a YYYY-MM-DD. Assembled by hand rather than through
 * Intl so the punctuation is the same on every runtime, and with no timezone
 * conversion that could shift the day.
 */
export function formatLongDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${d} ${MONTHS[m - 1]} ${y}`;
}

/** "today", "yesterday" or "N days ago", counted in India's calendar days. */
export function daysAgoLabel(ymd: string, now: Date = new Date()): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const [ty, tm, td] = todayIst(now).split("-").map(Number);
  if (!y || !ty) return "";
  const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86_400_000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return `${diff} days ago`;
}

/** An instant (created_at) as a short IST date, e.g. "5 Oct 2026". */
export function formatRecordedOn(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    timeZone: IST,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

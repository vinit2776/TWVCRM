/**
 * Dates of a Virtual Office renewal term.
 *
 * Renewal is continuous: the next term starts the day after the current one
 * ends, even when the customer pays late, and runs for whole months. A
 * discontinued case that comes back is a new case, never a gap in this one.
 *
 * Pure (date strings in, date strings out, UTC throughout) so the month-end
 * rules below are unit testable. The old code rolled dates with
 * Date#setMonth, which overflows: a term ending 31 Jan renewed for one month
 * landed on 3 Mar, and every renewal statement's period overlapped the
 * previous term by one day because it started on the old end date.
 */

const DAY_MS = 86_400_000;

function parse(date: string): Date {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function format(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function addDays(date: string, days: number): string {
  return format(new Date(parse(date).getTime() + days * DAY_MS));
}

/**
 * The same day `months` later, clamped to the target month's last day. A
 * date that is itself a month end stays a month end (28 Feb + 12 months is
 * 29 Feb in a leap year), so terms ending on month ends keep doing so.
 */
export function addMonthsEndAnchored(date: string, months: number): string {
  const d = parse(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const isMonthEnd = day === daysInMonth(y, m);

  const targetIndex = m + months;
  const ty = y + Math.floor(targetIndex / 12);
  const tm = ((targetIndex % 12) + 12) % 12;
  const last = daysInMonth(ty, tm);
  return format(new Date(Date.UTC(ty, tm, isMonthEnd ? last : Math.min(day, last))));
}

export interface RenewalTerm {
  start: string;
  end: string;
}

/**
 * The term that follows one ending on `currentEnd` (inclusive), lasting
 * `months` months. 19 Dec 2025 – 18 Dec 2026 is followed by
 * 19 Dec 2026 – 18 Dec 2027.
 */
export function nextRenewalTerm(currentEnd: string, months: number): RenewalTerm {
  const tenure = Number.isFinite(months) && months > 0 ? Math.floor(months) : 12;
  return {
    start: addDays(currentEnd, 1),
    end: addMonthsEndAnchored(currentEnd, tenure),
  };
}

/**
 * Whether a renewal statement billed the term that follows `currentEnd`.
 *
 * This is what makes completing a renewal safe to run twice: once the case
 * has rolled forward, the statement that paid for it no longer starts at the
 * case's end, so a replayed webhook or a second recorded payment cannot roll
 * the case again. Statements issued before this fix started on the old end
 * date itself, so that one-day overlap is accepted too.
 */
export function statementCoversNextTerm(
  statementPeriodStart: string | null | undefined,
  currentEnd: string | null | undefined,
): boolean {
  if (!statementPeriodStart || !currentEnd) return false;
  const start = statementPeriodStart.slice(0, 10);
  const end = currentEnd.slice(0, 10);
  return start === addDays(end, 1) || start === end;
}

/** Longest term a renewal statement is read back as (Start renewal offers up to 36). */
const MAX_TERM_MONTHS = 60;

/**
 * How many months a renewal statement billed, read back from its period.
 *
 * Start renewal lets the term length differ from the case's current tenure,
 * and the statement's period is the only record of what was offered, so
 * completion reads the length from there. Null when the period doesn't line
 * up with a whole-month term after `currentEnd` (older statements); callers
 * then fall back to the case's tenure.
 */
export function termMonthsFromPeriod(
  currentEnd: string | null | undefined,
  statementPeriodEnd: string | null | undefined,
): number | null {
  if (!currentEnd || !statementPeriodEnd) return null;
  const target = statementPeriodEnd.slice(0, 10);
  for (let m = 1; m <= MAX_TERM_MONTHS; m++) {
    if (addMonthsEndAnchored(currentEnd, m) === target) return m;
  }
  return null;
}

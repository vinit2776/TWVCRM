// Pure helpers for the monthly comparison view: month-on-month and year-on-year
// consumption from the meter's cumulative register. No I/O — the API route feeds
// it the readings at IST midnight.
//
// Everything is derived from the meter's own running total (cumulative_wh), never
// from stored per-interval deltas, which have proven unreliable (see MAX_GAP_MS in
// energy-baseline). A day's usage is the difference between two midnight readings;
// month-to-date at day N is the reading at the end of day N minus the reading at
// the start of the month. So a hole in readings *between* those two points changes
// nothing, and a day is only unknown when one of its own two bounding readings is
// missing — it is shown as unknown, never as zero.

import { addDays } from "@/lib/energy-baseline";

/** Cumulative Wh at the start (IST midnight) of each date, keyed YYYY-MM-DD. */
export type MidnightReadings = Map<string, number>;
export interface LatestReading { date: string; cumulative_wh: number }

export interface MonthData {
  /** YYYY-MM */
  month: string;
  daysInMonth: number;
  /** Days of the month that have started (all of them for a finished month). */
  elapsedDays: number;
  /** kWh used since the start of the month, at the end of each day; null where unknown or in the future. */
  cumulative: (number | null)[];
  /** kWh used on each day; null where either bounding reading is missing or the day hasn't happened. */
  daily: (number | null)[];
  /** kWh for the elapsed part of the month, or null if the month-start reading is missing. */
  totalKwh: number | null;
  /** Elapsed days whose usage could not be worked out. */
  unknownDays: number;
  /** Includes today, which is still accumulating. */
  partial: boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** `n` months before `month` (YYYY-MM). */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Built from a fixed list, not toLocaleDateString: the en-IN locale abbreviates
// September as "Sept", which reads oddly next to the "Sep" used everywhere else.
export function monthLabel(month: string, short = false): string {
  const [y, m] = month.split("-").map(Number);
  const name = MONTH_NAMES[m - 1];
  return short ? `${name.slice(0, 3)} ${String(y % 100).padStart(2, "0")}` : `${name} ${y}`;
}

const dateOf = (month: string, day: number) => `${month}-${String(day).padStart(2, "0")}`;

/** Reading at the start of `date`; for tomorrow-of-today, the latest reading stands in. */
function startOf(date: string, readings: MidnightReadings): number | null {
  return readings.get(date) ?? null;
}

export function buildMonth(month: string, readings: MidnightReadings, latest: LatestReading | null, today: string): MonthData {
  const dim = daysInMonth(month);
  const todayMonth = monthOf(today);
  const isCurrent = month === todayMonth;
  const elapsed = month > todayMonth ? 0 : isCurrent ? Number(today.slice(8, 10)) : dim;

  const monthStart = startOf(dateOf(month, 1), readings);
  // End of day d = start of d+1; for today, the most recent reading we hold.
  const endOfDay = (d: number): number | null => {
    const date = dateOf(month, d);
    if (date === today) return latest && latest.date === today ? latest.cumulative_wh : null;
    const next = d < dim ? dateOf(month, d + 1) : addDays(dateOf(month, d), 1);
    return startOf(next, readings);
  };

  const cumulative: (number | null)[] = new Array(dim).fill(null);
  const daily: (number | null)[] = new Array(dim).fill(null);
  let unknown = 0;
  for (let d = 1; d <= elapsed; d++) {
    const end = endOfDay(d);
    if (monthStart != null && end != null && end >= monthStart) cumulative[d - 1] = r1((end - monthStart) / 1000);
    const start = startOf(dateOf(month, d), readings);
    if (start != null && end != null && end >= start) daily[d - 1] = r1((end - start) / 1000);
    else unknown += 1;
  }

  let total: number | null = null;
  for (let i = elapsed - 1; i >= 0; i--) {
    if (cumulative[i] != null) { total = cumulative[i]; break; }
  }
  return { month, daysInMonth: dim, elapsedDays: elapsed, cumulative, daily, totalKwh: total, unknownDays: unknown, partial: isCurrent };
}

/** Cumulative kWh at the end of day `n` (1-based), or null. */
export function cumulativeAt(m: MonthData, n: number): number | null {
  if (n < 1 || n > m.daysInMonth) return null;
  return m.cumulative[n - 1];
}

/**
 * How `cur` stands against `other` over the same number of days. For a month in
 * progress that is the days elapsed so far; for a finished month, the whole month.
 * Null (not 0%) when either side has no figure to compare.
 */
export function compareSameDays(cur: MonthData, other: MonthData | null): { days: number; curKwh: number; otherKwh: number; pct: number } | null {
  if (!other || cur.elapsedDays < 1) return null;
  const days = cur.partial ? cur.elapsedDays : Math.min(cur.daysInMonth, other.daysInMonth);
  const c = cumulativeAt(cur, days);
  const o = cumulativeAt(other, days);
  if (c == null || o == null || o <= 0) return null;
  return { days, curKwh: c, otherKwh: o, pct: Math.round((c / o - 1) * 1000) / 10 };
}

export type DayClass = "weekday" | "saturday" | "sunday";

export function dayClassOf(date: string): DayClass {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 ? "sunday" : dow === 6 ? "saturday" : "weekday";
}

function classMeans(m: MonthData): Partial<Record<DayClass, { mean: number; n: number }>> {
  const acc: Record<DayClass, number[]> = { weekday: [], saturday: [], sunday: [] };
  m.daily.forEach((v, i) => { if (v != null) acc[dayClassOf(dateOf(m.month, i + 1))].push(v); });
  const out: Partial<Record<DayClass, { mean: number; n: number }>> = {};
  (Object.keys(acc) as DayClass[]).forEach((k) => {
    if (acc[k].length) out[k] = { mean: acc[k].reduce((a, b) => a + b, 0) / acc[k].length, n: acc[k].length };
  });
  return out;
}

export const MIN_DAYS_TO_PROJECT = 3;

/**
 * Month-end projection for the month in progress: what's used so far plus, for
 * each remaining day, the average for that kind of day (Mon–Fri / Sat / Sun).
 * A plain "average × days in month" would overstate a month that starts on a
 * weekday run and understate one that starts on a weekend. Kinds with fewer than
 * two days this month borrow last month's average. Null when too early to say.
 */
export function projectMonth(cur: MonthData, prev: MonthData | null): number | null {
  if (!cur.partial || cur.elapsedDays < MIN_DAYS_TO_PROJECT || cur.totalKwh == null) return null;
  const mine = classMeans(cur);
  const theirs = prev ? classMeans(prev) : {};
  let projected = cur.totalKwh;
  for (let d = cur.elapsedDays + 1; d <= cur.daysInMonth; d++) {
    const cls = dayClassOf(dateOf(cur.month, d));
    const own = mine[cls];
    const mean = own && own.n >= 2 ? own.mean : theirs[cls]?.mean ?? own?.mean;
    if (mean == null) return null;
    projected += mean;
  }
  return Math.round(projected);
}

export interface TrendPoint { month: string; kwh: number | null; partial: boolean; unknownDays: number }

/** Monthly totals for the `n` months ending at `endMonth`, oldest first. */
export function trend(endMonth: string, n: number, readings: MidnightReadings, latest: LatestReading | null, today: string): TrendPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const m = buildMonth(shiftMonth(endMonth, i - (n - 1)), readings, latest, today);
    return { month: m.month, kwh: m.totalKwh, partial: m.partial, unknownDays: m.unknownDays };
  });
}

export interface MonthStats { avgPerDay: number | null; peakDay: { day: number; kwh: number } | null }

export function monthStats(m: MonthData): MonthStats {
  const known = m.daily.map((v, i) => ({ v, day: i + 1 })).filter((x): x is { v: number; day: number } => x.v != null);
  if (known.length === 0) return { avgPerDay: null, peakDay: null };
  const peak = known.reduce((a, b) => (b.v > a.v ? b : a));
  return { avgPerDay: r1(known.reduce((a, b) => a + b.v, 0) / known.length), peakDay: { day: peak.day, kwh: peak.v } };
}

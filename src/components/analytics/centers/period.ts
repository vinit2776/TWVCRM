import type { DateRange } from "./types";

export type PeriodPresetId = "last_month" | "this_month" | "this_quarter" | "last_6mo" | "custom";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Today in IST as YYYY-MM-DD — mirrors todayIstDate() in center-metrics.ts. */
export function todayIso(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function firstOfMonthIso(monthsAgo: number): string {
  const [y, m] = todayIso().slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - monthsAgo, 1)).toISOString().slice(0, 10);
}

function lastMonthRange(): DateRange {
  const [y, m] = todayIso().slice(0, 7).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const lastDay = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(y, m - 2, lastDay)).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * "This quarter" and "Last 6 months" are rolling windows ending today, not
 * calendar/fiscal-quarter boundaries — India's FY (Apr start) vs a calendar
 * quarter would otherwise be a judgment call baked silently into the UI.
 * See docs/plans/center-analytics-data-source.md.
 */
export function rangeForPreset(preset: Exclude<PeriodPresetId, "custom">): DateRange {
  switch (preset) {
    case "this_month":
      return { start: firstOfMonthIso(0), end: todayIso() };
    case "last_month":
      return lastMonthRange();
    case "this_quarter":
      return { start: firstOfMonthIso(2), end: todayIso() };
    case "last_6mo":
      return { start: firstOfMonthIso(5), end: todayIso() };
  }
}

export const PERIOD_PRESETS: Array<{ id: Exclude<PeriodPresetId, "custom">; label: string }> = [
  { id: "last_month", label: "Last month" },
  { id: "this_month", label: "This month" },
  { id: "this_quarter", label: "This quarter" },
  { id: "last_6mo", label: "Last 6 months" },
];

export function isMtd(range: DateRange): boolean {
  return range.end === todayIso();
}

/** The equal-length window immediately before `range`, for "vs prior period" deltas. */
export function priorRangeOf(range: DateRange): DateRange {
  const startMs = Date.parse(range.start + "T00:00:00Z");
  const endMs = Date.parse(range.end + "T00:00:00Z");
  const lengthDays = Math.round((endMs - startMs) / 86400000) + 1;
  const priorEnd = new Date(startMs - 86400000).toISOString().slice(0, 10);
  const priorStart = new Date(startMs - lengthDays * 86400000).toISOString().slice(0, 10);
  return { start: priorStart, end: priorEnd };
}

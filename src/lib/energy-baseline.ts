// Pure helpers that turn the local 15-minute energy ledger into per-day usage,
// classify each day (working / Sunday / public holiday) and derive baselines.
// Kept free of I/O so the maths is unit-testable; the API route feeds it rows.

export type DayType = "working" | "sunday" | "holiday";

export interface LedgerBucket {
  ts: string;
  energy_delta_wh: number | null;
  // Set by markGaps: this row's delta spans a stretch with no stored readings.
  gap?: boolean;
}

export interface HolidayEntry {
  date: string; // YYYY-MM-DD
  name: string;
}

export interface DailyUsage {
  date: string; // IST calendar day, YYYY-MM-DD
  kwh: number;
  buckets: number;
  // Only complete days feed baselines — a half-synced day would drag them down.
  complete: boolean;
  dayType: DayType;
  holidayName?: string;
}

export interface BaselineStats {
  days: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

export interface BaselineWindow {
  key: string;
  label: string;
  windowDays: number;
  from: string;
  to: string;
  working: BaselineStats;
  nonWorking: BaselineStats;
  baseLoadKw: number | null;
  // Earliest day with any ledger data inside the window — lets the UI say
  // "history only starts on …" instead of presenting a thin year as a year.
  coveredFrom: string | null;
}

export interface WeekdayProfile {
  weekday: number; // 0 = Sunday
  median: number | null;
  days: number;
}

export interface Anomaly {
  date: string;
  kwh: number;
  expected: number;
  deviationPct: number;
}

const SLOT_MS = 15 * 60 * 1000;
// A day with a handful of missing 15-minute slots (meter hiccup) is still
// usable; below this it is treated as partial.
export const MIN_SLOTS_FOR_COMPLETE_DAY = 92;
// A delta is the meter's cumulative change since the previous stored row. When
// that row is much older, the delta is the whole unobserved stretch dumped into
// one reading (observed: ~9 days of usage, 1,269 kWh, in a single 15-minute
// slot after a ledger gap). Past this spacing the delta is not a usable
// per-interval figure.
export const MAX_GAP_MS = 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istParts(ts: string) {
  const shifted = new Date(new Date(ts).getTime() + IST_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
  };
}

export function istDateOf(ts: string): string {
  return istParts(ts).date;
}

export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function classifyDay(date: string, holidays: Map<string, string>): { dayType: DayType; holidayName?: string } {
  const holidayName = holidays.get(date);
  // A holiday that lands on a Sunday stays "holiday" so the name is visible.
  if (holidayName) return { dayType: "holiday", holidayName };
  if (weekdayOf(date) === 0) return { dayType: "sunday" };
  return { dayType: "working" };
}

// Sorts by time and flags every row that follows a stretch with no stored
// readings (see MAX_GAP_MS). Idempotent.
export function markGaps(buckets: LedgerBucket[]): LedgerBucket[] {
  const sorted = [...buckets].sort((a, b) => a.ts.localeCompare(b.ts));
  return sorted.map((b, i) => ({
    ...b,
    gap: b.gap || (i > 0 && new Date(b.ts).getTime() - new Date(sorted[i - 1].ts).getTime() > MAX_GAP_MS),
  }));
}

// Rolls 15-minute buckets up to IST calendar days. `today` (IST) is never
// complete: it is still accumulating.
export function aggregateDaily(buckets: LedgerBucket[], holidays: HolidayEntry[], today: string): DailyUsage[] {
  const holidayMap = new Map(holidays.map((h) => [h.date, h.name]));
  const byDay = new Map<string, { wh: number; slots: Set<number>; bad: boolean }>();
  for (const b of markGaps(buckets)) {
    if (b.energy_delta_wh == null) continue;
    const day = istDateOf(b.ts);
    const agg = byDay.get(day) ?? { wh: 0, slots: new Set<number>(), bad: false };
    // Off-grid captures (e.g. taken when headcount is logged) share a slot with
    // a regular reading, so coverage counts distinct slots, not rows. Their
    // deltas still sum correctly: each is the cumulative change since the prior row.
    agg.slots.add(Math.floor(new Date(b.ts).getTime() / SLOT_MS));
    // A negative delta means a meter reset/rollover, and a gap means the delta
    // covers unobserved time — either way the day's total can't be trusted.
    if (b.energy_delta_wh < 0 || b.gap) agg.bad = true;
    else agg.wh += b.energy_delta_wh;
    byDay.set(day, agg);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, agg]) => ({
      date,
      kwh: Math.round((agg.wh / 1000) * 100) / 100,
      buckets: agg.slots.size,
      complete: date < today && agg.slots.size >= MIN_SLOTS_FOR_COMPLETE_DAY && !agg.bad,
      ...classifyDay(date, holidayMap),
    }));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function baselineStats(values: number[]): BaselineStats {
  if (values.length === 0) return { days: 0, median: null, p25: null, p75: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    days: sorted.length,
    median: round1(percentile(sorted, 0.5)),
    p25: round1(percentile(sorted, 0.25)),
    p75: round1(percentile(sorted, 0.75)),
  };
}

// Median overnight draw (01:00–05:00 IST) on complete non-working days is the
// closest thing to a true idle load — nobody is in, only always-on equipment runs.
function baseLoadKw(buckets: LedgerBucket[], completeNonWorkingDays: Set<string>): number | null {
  const kw: number[] = [];
  for (const b of buckets) {
    if (b.energy_delta_wh == null || b.energy_delta_wh < 0 || b.gap) continue;
    const { date, hour } = istParts(b.ts);
    if (hour >= 1 && hour < 5 && completeNonWorkingDays.has(date)) kw.push((b.energy_delta_wh * 4) / 1000);
  }
  if (kw.length === 0) return null;
  kw.sort((a, b) => a - b);
  return Math.round(percentile(kw, 0.5) * 100) / 100;
}

export const BASELINE_WINDOWS = [
  { key: "30d", label: "Last 30 days", windowDays: 30 },
  { key: "90d", label: "Last quarter (90 days)", windowDays: 90 },
  { key: "365d", label: "Last year (365 days)", windowDays: 365 },
] as const;

// Windows end yesterday (today is partial) and only count complete days.
export function computeBaselines(daily: DailyUsage[], rawBuckets: LedgerBucket[], today: string): BaselineWindow[] {
  const buckets = markGaps(rawBuckets);
  const to = addDays(today, -1);
  return BASELINE_WINDOWS.map((w) => {
    const from = addDays(to, -(w.windowDays - 1));
    const inWindow = daily.filter((d) => d.date >= from && d.date <= to);
    const complete = inWindow.filter((d) => d.complete);
    const nonWorkingDays = new Set(complete.filter((d) => d.dayType !== "working").map((d) => d.date));
    const windowBuckets = buckets.filter((b) => {
      const day = istDateOf(b.ts);
      return day >= from && day <= to;
    });
    return {
      key: w.key,
      label: w.label,
      windowDays: w.windowDays,
      from,
      to,
      working: baselineStats(complete.filter((d) => d.dayType === "working").map((d) => d.kwh)),
      nonWorking: baselineStats(complete.filter((d) => d.dayType !== "working").map((d) => d.kwh)),
      baseLoadKw: baseLoadKw(windowBuckets, nonWorkingDays),
      coveredFrom: inWindow.length ? inWindow[0].date : null,
    };
  });
}

// Per-weekday medians (Sunday=0) over complete days — lets a reader judge
// whether Saturday behaves like a full or half working day.
export function weekdayProfile(daily: DailyUsage[], from: string, to: string): WeekdayProfile[] {
  const complete = daily.filter((d) => d.complete && d.dayType !== "holiday" && d.date >= from && d.date <= to);
  return [1, 2, 3, 4, 5, 6, 0].map((weekday) => {
    const values = complete.filter((d) => weekdayOf(d.date) === weekday).map((d) => d.kwh);
    return { weekday, median: baselineStats(values).median, days: values.length };
  });
}

// Flags complete days far from their own class's median. The threshold is the
// larger of 3 scaled MADs and 20 % of the median, so a very steady baseline
// doesn't turn ordinary noise into alerts.
export function findAnomalies(daily: DailyUsage[], reference: BaselineWindow): Anomaly[] {
  const out: Anomaly[] = [];
  for (const [stats, isWorking] of [[reference.working, true], [reference.nonWorking, false]] as const) {
    if (stats.median == null || stats.days < 5) continue;
    const peers = daily
      .filter((d) => d.complete && d.date >= reference.from && d.date <= reference.to && (d.dayType === "working") === isWorking)
      .map((d) => d.kwh);
    const mad = baselineStats(peers.map((v) => Math.abs(v - stats.median!))).median ?? 0;
    const threshold = Math.max(3 * 1.4826 * mad, 0.2 * stats.median);
    for (const d of daily) {
      if (!d.complete || d.date < reference.from || d.date > reference.to) continue;
      if ((d.dayType === "working") !== isWorking) continue;
      const diff = d.kwh - stats.median;
      if (Math.abs(diff) > threshold) {
        out.push({ date: d.date, kwh: d.kwh, expected: stats.median, deviationPct: Math.round((diff / stats.median) * 100) });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

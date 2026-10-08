import {
  aggregateDaily, addDays, classifyDay, istDateOf, istToday, markGaps, weekdayOf,
  type DailyUsage, type HolidayEntry, type LedgerBucket,
} from "@/lib/energy-baseline";

// "Today vs baseline": today's cumulative usage (and per-slot power) against the
// typical curve for the same kind of day, built from the local ledger.

export type DayClass = "weekday" | "saturday" | "off";
export type TodayStatus = "on_track" | "behind" | "ahead" | "too_early" | "insufficient" | "no_data";

export interface Quantiles { p25: number | null; med: number | null; p75: number | null }

export interface TodaySlot {
  k: number; // 15-minute slot of the IST day, 0..95
  time: string; // HH:MM IST
  today: number | null; // cumulative kWh since midnight
  proj: number | null; // projected cumulative kWh, from the latest slot onward
  p25: number | null;
  med: number | null;
  p75: number | null;
  kw: number | null; // average power over the slot
  kwP25: number | null;
  kwMed: number | null;
  kwP75: number | null;
}

export interface TodayComparison {
  date: string;
  dayClass: DayClass;
  dayLabel: string;
  // True when Saturday has too few complete Saturdays yet and all working days are used.
  fallback: boolean;
  peers: number;
  windowFrom: string;
  windowTo: string;
  lastSlot: number | null;
  asOf: string | null;
  todayKwh: number | null;
  typicalNow: Quantiles | null;
  diffKwh: number | null;
  projectedKwh: number | null;
  typicalEnd: Quantiles | null;
  status: TodayStatus;
  slots: TodaySlot[];
}

const SLOTS = 96;
const SLOT_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const BASELINE_DAYS = 30;
export const MIN_PEERS = 3;
// Saturdays are rare in a 30-day window; with fewer than this, compare against
// all working days instead (and say so).
export const MIN_SATURDAY_PEERS = 4;
// Until the typical day has done this share of its total, the morning ramp is
// still under way and a few minutes' difference in start time swamps any signal.
export const RAMP_SHARE = 0.25;
// How far outside the typical band counts as behind/ahead.
export const TOLERANCE = 0.1;

const DAY_LABELS: Record<DayClass, string> = {
  weekday: "Mon–Fri working days",
  saturday: "Saturdays",
  off: "Sundays and holidays",
};

export function dayClassOf(date: string, dayType: "working" | "sunday" | "holiday"): DayClass {
  if (dayType !== "working") return "off";
  return weekdayOf(date) === 6 ? "saturday" : "weekday";
}

function slotTime(k: number): string {
  return `${String(Math.floor(k / 4)).padStart(2, "0")}:${String((k % 4) * 15).padStart(2, "0")}`;
}

function quantile(values: (number | null)[], p: number): number | null {
  const v = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

interface Curve {
  base: number | null; // cumulative Wh at the end of the previous day
  cum: (number | null)[]; // cumulative Wh at each on-grid slot
}

// Per-IST-day cumulative readings by 15-minute slot. Off-grid captures are
// provisional "latest" points and are ignored here; the base is the last reading
// before midnight, and a day that follows a hole has no usable base.
function buildCurves(rows: LedgerBucket[]): Map<string, Curve> {
  const sorted = markGaps(rows).filter((r) => r.cumulative_wh != null);
  const curves = new Map<string, Curve>();
  sorted.forEach((r, i) => {
    const day = istDateOf(r.ts);
    let curve = curves.get(day);
    if (!curve) {
      curve = { base: i > 0 && !r.gap ? sorted[i - 1].cumulative_wh : null, cum: new Array(SLOTS).fill(null) };
      curves.set(day, curve);
    }
    const ms = new Date(r.ts).getTime();
    if (ms % SLOT_MS === 0) {
      const k = Math.round(((ms + IST_OFFSET_MS) % DAY_MS) / SLOT_MS);
      if (k < SLOTS) curve.cum[k] = r.cumulative_wh;
    }
  });
  return curves;
}

function cumulativeKwh(curve: Curve): (number | null)[] {
  return curve.cum.map((v) => (v == null || curve.base == null ? null : (v - curve.base) / 1000));
}

function powerKw(curve: Curve): (number | null)[] {
  return curve.cum.map((v, k) => {
    const prev = k === 0 ? curve.base : curve.cum[k - 1];
    return v == null || prev == null ? null : ((v - prev) * 4) / 1000; // Wh per 15 min -> kW
  });
}

export function buildTodayComparison(
  rows: LedgerBucket[],
  holidays: HolidayEntry[],
  now: Date = new Date()
): TodayComparison {
  const today = istToday(now);
  const windowFrom = addDays(today, -BASELINE_DAYS);
  const windowTo = addDays(today, -1);
  const holidayMap = new Map(holidays.map((h) => [h.date, h.name]));
  const todayClass = dayClassOf(today, classifyDay(today, holidayMap).dayType);

  const daily: DailyUsage[] = aggregateDaily(rows, holidays, today);
  const complete = daily.filter((d) => d.complete && d.date >= windowFrom && d.date <= windowTo);
  const sameClass = complete.filter((d) => dayClassOf(d.date, d.dayType) === todayClass);

  let peerDays = sameClass;
  let fallback = false;
  if (todayClass === "saturday" && sameClass.length < MIN_SATURDAY_PEERS) {
    peerDays = complete.filter((d) => d.dayType === "working");
    fallback = true;
  }

  const curves = buildCurves(rows);
  const peerCurves = peerDays
    .map((d) => curves.get(d.date))
    .filter((c): c is Curve => c != null && c.base != null);
  const peerKwh = peerCurves.map(cumulativeKwh);
  const peerKw = peerCurves.map(powerKw);

  const todayCurve = curves.get(today);
  const todayKwhSeries = todayCurve && todayCurve.base != null ? cumulativeKwh(todayCurve) : null;
  const todayKwSeries = todayCurve && todayCurve.base != null ? powerKw(todayCurve) : null;
  let lastSlot: number | null = null;
  if (todayKwhSeries) todayKwhSeries.forEach((v, k) => { if (v != null) lastSlot = k; });

  const enough = peerCurves.length >= MIN_PEERS;
  const band = (series: (number | null)[][], k: number): Quantiles => {
    const col = series.map((s) => s[k]);
    if (!enough || col.filter((x) => x != null).length < MIN_PEERS) return { p25: null, med: null, p75: null };
    return { p25: quantile(col, 0.25), med: quantile(col, 0.5), p75: quantile(col, 0.75) };
  };

  const kwhBands = Array.from({ length: SLOTS }, (_, k) => band(peerKwh, k));
  const kwBands = Array.from({ length: SLOTS }, (_, k) => band(peerKw, k));
  const typicalEnd = kwhBands[SLOTS - 1].med != null ? kwhBands[SLOTS - 1] : null;
  const typicalNow = lastSlot != null && kwhBands[lastSlot].med != null ? kwhBands[lastSlot] : null;
  const todayKwh = lastSlot != null && todayKwhSeries ? todayKwhSeries[lastSlot] : null;

  // Add the typical rest-of-day to what has already been used. Scaling today's
  // pace up instead would swing wildly in the steep morning ramp.
  const projectedKwh =
    todayKwh != null && typicalNow?.med != null && typicalEnd?.med != null
      ? todayKwh + (typicalEnd.med - typicalNow.med)
      : null;

  let status: TodayStatus;
  if (todayKwh == null || lastSlot == null) status = "no_data";
  else if (!typicalNow || !typicalEnd) status = "insufficient";
  else if (typicalNow.med! < RAMP_SHARE * typicalEnd.med!) status = "too_early";
  else if (todayKwh < typicalNow.p25! * (1 - TOLERANCE)) status = "behind";
  else if (todayKwh > typicalNow.p75! * (1 + TOLERANCE)) status = "ahead";
  else status = "on_track";

  const slots: TodaySlot[] = Array.from({ length: SLOTS }, (_, k) => ({
    k,
    time: slotTime(k),
    today: todayKwhSeries && lastSlot != null && k <= lastSlot ? r1(todayKwhSeries[k]) : null,
    proj:
      projectedKwh != null && lastSlot != null && k >= lastSlot && kwhBands[k].med != null && typicalNow?.med != null
        ? r1(todayKwh! + (kwhBands[k].med! - typicalNow.med))
        : null,
    p25: r1(kwhBands[k].p25),
    med: r1(kwhBands[k].med),
    p75: r1(kwhBands[k].p75),
    kw: todayKwSeries && lastSlot != null && k <= lastSlot ? r2(todayKwSeries[k]) : null,
    kwP25: r2(kwBands[k].p25),
    kwMed: r2(kwBands[k].med),
    kwP75: r2(kwBands[k].p75),
  }));

  const q = (b: Quantiles | null): Quantiles | null =>
    b ? { p25: r1(b.p25), med: r1(b.med), p75: r1(b.p75) } : null;

  return {
    date: today,
    dayClass: todayClass,
    dayLabel: DAY_LABELS[todayClass],
    fallback,
    peers: peerCurves.length,
    windowFrom,
    windowTo,
    lastSlot,
    asOf: lastSlot != null ? slotTime(lastSlot) : null,
    todayKwh: r1(todayKwh),
    typicalNow: q(typicalNow),
    diffKwh: todayKwh != null && typicalNow?.med != null ? r1(todayKwh - typicalNow.med) : null,
    projectedKwh: r1(projectedKwh),
    typicalEnd: q(typicalEnd),
    status,
    slots,
  };
}

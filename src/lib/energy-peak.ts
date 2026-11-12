// Pure helpers for the "peak day" view: per-day maximum demand from the local
// 15-minute energy ledger. No I/O — the API route feeds it rows.
//
// Demand for a 15-minute slot is the meter's cumulative step across that slot,
// ×4 (Wh per quarter-hour → kW). It is deliberately derived from the cumulative
// reading, and only from two stored readings exactly 15 minutes apart. Stored
// `energy_delta_wh` values are not used: one has been seen holding ~9 days of
// usage after a ledger gap, which would read as a peak of thousands of kW (see
// MAX_GAP_MS in energy-baseline). A slot with no reading 15 minutes before it
// simply has no demand figure, so a gap can hide a peak but can never invent one.

import {
  classifyDay,
  istDateOf,
  type DayType,
  type HolidayEntry,
  type LedgerBucket,
} from "@/lib/energy-baseline";

export const SLOTS_PER_DAY = 96;
export const SLOT_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** A day is complete enough to rank and compare once this many slots have a figure. */
export const MIN_SLOTS_COMPLETE = 92;
/** Need this many comparable prior days before saying "vs previous days". */
export const MIN_COMPARE_DAYS = 3;
/** Need this many complete days before ranking a day among them. */
export const MIN_RANK_DAYS = 10;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** kW per 15-minute slot (index 0 = 00:00–00:15 IST), null where there is no trustworthy figure. */
export type DayCurve = (number | null)[];

/**
 * IST-day → 96 slots of kW. A slot's kW is attributed to the quarter-hour it
 * covers; a reading stamped 00:15 closes slot 0.
 */
export function buildDayCurves(rows: LedgerBucket[]): Map<string, DayCurve> {
  const cumAt = new Map<number, number>();
  for (const r of rows) {
    if (r.cumulative_wh == null) continue;
    const ms = new Date(r.ts).getTime();
    if (ms % SLOT_MS !== 0) continue; // off-grid captures are provisional, not a full slot
    cumAt.set(ms, r.cumulative_wh);
  }

  const curves = new Map<string, DayCurve>();
  for (const [ms, cum] of cumAt) {
    const prev = cumAt.get(ms - SLOT_MS);
    if (prev == null) continue; // no reading 15 minutes earlier → no figure for this slot
    const step = cum - prev;
    if (step < 0) continue; // meter reset / rollover
    // The slot ends at `ms`, so it belongs to the day containing its start.
    const startMs = ms - SLOT_MS;
    const date = istDateOf(new Date(startMs).toISOString());
    const k = Math.round(((startMs + IST_OFFSET_MS) % DAY_MS) / SLOT_MS);
    let curve = curves.get(date);
    if (!curve) {
      curve = new Array<number | null>(SLOTS_PER_DAY).fill(null);
      curves.set(date, curve);
    }
    curve[k] = (step * 4) / 1000;
  }
  return curves;
}

export interface DayPeak {
  date: string; // IST calendar day
  dayType: DayType;
  holidayName?: string;
  peakKw: number;
  /** Slot index of the peak (0–95). */
  peakSlot: number;
  avgKw: number;
  kwh: number;
  /** Median draw 01:00–05:00 IST — the closest thing to idle load. */
  baseKw: number | null;
  /** avg ÷ peak; 1 = perfectly flat. */
  loadFactor: number;
  slots: number;
  /** Enough slots to rank/compare, and not today (still accumulating). */
  complete: boolean;
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summariseDay(date: string, curve: DayCurve, today: string, holidays: Map<string, string>): DayPeak | null {
  let peakSlot = -1;
  let sum = 0;
  let n = 0;
  curve.forEach((v, k) => {
    if (v == null) return;
    sum += v;
    n += 1;
    if (peakSlot < 0 || v > (curve[peakSlot] as number)) peakSlot = k;
  });
  if (n === 0 || peakSlot < 0) return null;
  const peakKw = curve[peakSlot] as number;
  const avgKw = sum / n;
  const night = curve.slice(4, 20).filter((v): v is number => v != null);
  return {
    date,
    ...classifyDay(date, holidays),
    peakKw: r1(peakKw),
    peakSlot,
    avgKw: r1(avgKw),
    kwh: r1(sum / 4),
    baseKw: night.length >= 8 ? r1(median(night) as number) : null,
    loadFactor: peakKw > 0 ? r2(avgKw / peakKw) : 0,
    slots: n,
    complete: date < today && n >= MIN_SLOTS_COMPLETE,
  };
}

/** Daily summaries for `from`…`to` inclusive (IST dates); days with no usable slot are omitted. */
export function dailyPeaks(rows: LedgerBucket[], holidays: HolidayEntry[], today: string, from: string, to: string): DayPeak[] {
  const holidayMap = new Map(holidays.map((h) => [h.date, h.name]));
  const out: DayPeak[] = [];
  for (const [date, curve] of buildDayCurves(rows)) {
    if (date < from || date > to) continue;
    const s = summariseDay(date, curve, today, holidayMap);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** One day's 96-slot curve in kW (nulls where missing), rounded for transport. */
export function dayCurve(rows: LedgerBucket[], date: string): DayCurve {
  const c = buildDayCurves(rows).get(date);
  return (c ?? new Array<number | null>(SLOTS_PER_DAY).fill(null)).map((v) => (v == null ? null : r2(v)));
}

export const TIME_BANDS = [
  { label: "Night 00–06", from: 0, to: 24 },
  { label: "Morning 06–12", from: 24, to: 48 },
  { label: "Afternoon 12–18", from: 48, to: 72 },
  { label: "Evening 18–24", from: 72, to: 96 },
] as const;

/** kWh used in each time-of-day band (slots with no figure contribute nothing). */
export function bandKwh(curve: DayCurve): { label: string; kwh: number }[] {
  return TIME_BANDS.map((b) => ({
    label: b.label,
    kwh: r1(curve.slice(b.from, b.to).reduce<number>((a, v) => a + (v ?? 0), 0) / 4),
  }));
}

/** "09:15" for slot 37. */
export function slotLabel(k: number): string {
  const m = k * 15;
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Selected day's peak against the average peak of comparable complete days:
 * working days look back 7 days, Sundays and holidays look back 28 (they are
 * rarer, and comparing a Sunday with weekdays says nothing). Null (not 0%) when
 * there are too few comparable days.
 */
export function peakVsPrior(daily: DayPeak[], date: string): { pct: number; avgKw: number; basis: "working" | "off" } | null {
  const target = daily.find((d) => d.date === date);
  if (!target) return null;
  const working = target.dayType === "working";
  const lookbackMs = (working ? 7 : 28) * DAY_MS;
  const start = new Date(`${date}T00:00:00Z`).getTime() - lookbackMs;
  const prior = daily.filter((d) => {
    const t = new Date(`${d.date}T00:00:00Z`).getTime();
    return d.complete && t >= start && d.date < date && (d.dayType === "working") === working;
  });
  if (prior.length < MIN_COMPARE_DAYS) return null;
  const avg = prior.reduce((a, d) => a + d.peakKw, 0) / prior.length;
  return avg > 0 ? { pct: Math.round((target.peakKw / avg - 1) * 100), avgKw: Math.round(avg), basis: working ? "working" : "off" } : null;
}

/** Rank (1 = highest peak) of `date` among the complete days given; null for partial days or too little history. */
export function peakRank(daily: DayPeak[], date: string): { rank: number; of: number } | null {
  const complete = daily.filter((d) => d.complete);
  const target = complete.find((d) => d.date === date);
  if (!target || complete.length < MIN_RANK_DAYS) return null;
  const rank = complete.filter((d) => d.peakKw > target.peakKw).length + 1;
  return { rank, of: complete.length };
}

/** Highest-peak complete days, best first. */
export function topPeakDays(daily: DayPeak[], n = 5): DayPeak[] {
  return daily.filter((d) => d.complete).sort((a, b) => b.peakKw - a.peakKw || b.date.localeCompare(a.date)).slice(0, n);
}

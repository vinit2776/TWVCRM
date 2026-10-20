/**
 * Customer Value — shaping stored history for the Performance sub-tab.
 *
 * Pure helpers over the two snapshot tables: one point per month for each chart,
 * a range switcher that only re-slices rows already fetched, and honest handling
 * of gaps (a month with nothing to measure is a gap in the line, never a zero).
 */

export const PERFORMANCE_PILLARS = ["payment", "friction", "engagement", "profitability"] as const;
export type PerformancePillar = (typeof PERFORMANCE_PILLARS)[number];

/** Colours chosen to stay distinct for the common kinds of colour blindness. */
export const PILLAR_COLORS: Record<PerformancePillar, string> = {
  payment: "#2563eb",
  friction: "#d97706",
  engagement: "#059669",
  profitability: "#7c3aed",
};

export interface PerfScoreRow {
  as_of: string;
  payment: number | null;
  friction: number | null;
  engagement: number | null;
  profitability: number | null;
  overall: number | null;
  tier: string | null;
  status: string;
}

export interface PerfMonthRow {
  month: string;
  avg_days_late: number | null;
  measured_count: number;
  on_time_count: number;
  seats_paid: number | null;
  seats_used_avg: number | null;
  tickets_linked: number;
  tickets_unlinked: number;
  tickets_sla_breached: number;
  data_flags: { door?: string; partial_month?: boolean } | null;
}

export type RangeKey = "6" | "12" | "all";
export const RANGE_LABELS: Record<RangeKey, string> = { "6": "6 months", "12": "12 months", all: "Since the start" };

function monthIndex(ymd: string): number {
  return Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(5, 7)) - 1;
}

/** Whether a `YYYY-MM-DD` date falls inside the range ending at `today`'s month. */
function inRange(ymd: string, today: string, range: RangeKey): boolean {
  const age = monthIndex(today) - monthIndex(ymd);
  if (age < 0) return false;
  return range === "all" ? true : age < Number(range);
}

export interface PillarPoint {
  asOf: string;
  payment: number | null;
  friction: number | null;
  engagement: number | null;
  profitability: number | null;
  overall: number | null;
}

/**
 * One point per month: the last stored score of that month, oldest first.
 * Rows with no pillar value at all are skipped. Pillars can be null in a point
 * (that pillar could not be scored that month) and are drawn as gaps.
 */
export function pillarSeries(rows: PerfScoreRow[], today: string, range: RangeKey): PillarPoint[] {
  const lastPerMonth = new Map<string, PerfScoreRow>();
  for (const r of [...rows].sort((a, b) => (a.as_of < b.as_of ? -1 : 1))) {
    if (!inRange(r.as_of, today, range)) continue;
    if (PERFORMANCE_PILLARS.every((p) => r[p] === null)) continue;
    lastPerMonth.set(r.as_of.slice(0, 7), r);
  }
  return [...lastPerMonth.values()].map((r) => ({
    asOf: r.as_of,
    payment: r.payment,
    friction: r.friction,
    engagement: r.engagement,
    profitability: r.profitability,
    overall: r.overall,
  }));
}

export function monthlyInRange(rows: PerfMonthRow[], today: string, range: RangeKey): PerfMonthRow[] {
  return rows.filter((r) => inRange(r.month, today, range)).sort((a, b) => (a.month < b.month ? -1 : 1));
}

export interface DaysToPayPoint {
  month: string;
  /** Average days after the due date (negative = early); null when no invoice that fell due could be timed. */
  days: number | null;
  invoices: number;
  onTime: number;
}

export function daysToPayPoints(rows: PerfMonthRow[]): DaysToPayPoint[] {
  return rows.map((r) => ({
    month: r.month,
    days: r.measured_count > 0 ? r.avg_days_late : null,
    invoices: r.measured_count,
    onTime: r.on_time_count,
  }));
}

export interface SeatPoint {
  month: string;
  paid: number | null;
  used: number | null;
}

export function seatPoints(rows: PerfMonthRow[]): { points: SeatPoint[]; hasUsage: boolean } {
  const points = rows.map((r) => ({ month: r.month, paid: r.seats_paid, used: r.seats_used_avg }));
  return { points, hasUsage: points.some((p) => p.used !== null) };
}

export interface TicketPoint {
  month: string;
  tickets: number;
  breached: number;
  unlinked: number;
}

export function ticketPoints(rows: PerfMonthRow[]): { points: TicketPoint[]; total: number; unlinkedTotal: number } {
  const points = rows.map((r) => ({
    month: r.month,
    tickets: r.tickets_linked,
    breached: r.tickets_sla_breached,
    unlinked: r.tickets_unlinked,
  }));
  return {
    points,
    total: points.reduce((n, p) => n + p.tickets, 0),
    unlinkedTotal: points.reduce((n, p) => n + p.unlinked, 0),
  };
}

/** A symmetric-ish vertical range around zero for days late, so early and late both show. */
export function daysRange(values: number[]): { lo: number; hi: number } {
  const max = Math.max(5, ...values.map((v) => Math.ceil(v)));
  const min = Math.min(0, ...values.map((v) => Math.floor(v)));
  return { lo: Math.min(min, -2), hi: max };
}

/** A tidy upper bound for a count axis. */
export function countCeiling(values: number[], minimum = 4): number {
  const max = Math.max(minimum, ...values);
  return max <= 10 ? max : Math.ceil(max / 5) * 5;
}

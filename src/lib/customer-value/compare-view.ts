/**
 * Customer Value — comparing one customer with the rest of their center
 * (docs/customer-value-tab-spec.md, section 5.4).
 *
 * Pure helpers over the stored monthly rows. Every customer at the center is
 * reduced to one figure per measure over the same recent window, then this
 * customer is placed among the others: average, rank, a histogram with their
 * position, and a month-by-month days-to-pay line against the center average.
 *
 * A measure a customer cannot be measured on (no door data, no seats) is null
 * and is left out of that measure's cohort, never counted as zero.
 */

export const COMPARE_WINDOW_MONTHS = 6;
/** Same minimum as the scoring run: fewer peers than this is shown, but not judged. */
export const COMPARE_MIN_PEERS = 8;
/** A peer needs at least this many months of figures in the fetched history to count. */
export const COMPARE_MIN_PEER_MONTHS = 3;
const HISTOGRAM_BINS = 8;

export interface CompareMonthRow {
  lead_id: string;
  month: string;
  avg_days_late: number | null;
  measured_count: number;
  on_time_count: number;
  reminders: number;
  seats_paid: number | null;
  seats_used_avg: number | null;
  rent_per_seat: number | null;
  tickets_linked: number;
}

export type CompareMeasureKey = "daysToPay" | "onTimePct" | "remindersPerQuarter" | "rentPerSeat" | "seatUse" | "ticketsPerSeat";

interface MeasureDef {
  key: CompareMeasureKey;
  label: string;
  unit: string;
  /** Which direction is better; "none" for a measure that is a fact, not a merit (rent). */
  better: "lower" | "higher" | "none";
  note?: string;
}

export const COMPARE_MEASURES: MeasureDef[] = [
  { key: "daysToPay", label: "Days to pay", unit: "days", better: "lower", note: "After the due date; negative is early." },
  { key: "onTimePct", label: "Paid on time", unit: "%", better: "higher" },
  { key: "remindersPerQuarter", label: "Reminders", unit: "per quarter", better: "lower" },
  { key: "rentPerSeat", label: "Rent per seat", unit: "₹", better: "none" },
  { key: "seatUse", label: "Seats used vs paid", unit: "%", better: "higher", note: "Needs door-access data." },
  { key: "ticketsPerSeat", label: "Tickets per seat", unit: "per quarter", better: "lower", note: "Only tickets that can be tied to a customer." },
];

export type CustomerFigures = Record<CompareMeasureKey, number | null>;

function monthIndex(ymd: string): number {
  return Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(5, 7)) - 1;
}

function inWindow(month: string, today: string, months: number): boolean {
  const age = monthIndex(today) - monthIndex(month);
  return age >= 0 && age < months;
}

/** One customer's figure for every measure over the window; null where there is nothing to measure. */
export function customerFigures(rows: CompareMonthRow[], today: string, windowMonths = COMPARE_WINDOW_MONTHS): CustomerFigures {
  const w = rows.filter((r) => inWindow(r.month, today, windowMonths));
  const measured = w.filter((r) => r.measured_count > 0 && r.avg_days_late !== null);
  const measuredTotal = measured.reduce((n, r) => n + r.measured_count, 0);

  const daysToPay = measuredTotal > 0 ? measured.reduce((n, r) => n + (r.avg_days_late as number) * r.measured_count, 0) / measuredTotal : null;
  const allMeasured = w.reduce((n, r) => n + r.measured_count, 0);
  const onTimePct = allMeasured > 0 ? (w.reduce((n, r) => n + r.on_time_count, 0) / allMeasured) * 100 : null;
  const remindersPerQuarter = w.length > 0 ? (w.reduce((n, r) => n + r.reminders, 0) / w.length) * 3 : null;

  const rents = w.flatMap((r) => (r.rent_per_seat === null ? [] : [r.rent_per_seat]));
  const rentPerSeat = rents.length > 0 ? rents.reduce((a, b) => a + b, 0) / rents.length : null;

  const used = w.filter((r) => r.seats_used_avg !== null && r.seats_paid !== null && r.seats_paid > 0);
  const usedPaid = used.reduce((n, r) => n + (r.seats_paid as number), 0);
  const seatUse = usedPaid > 0 ? (used.reduce((n, r) => n + (r.seats_used_avg as number), 0) / usedPaid) * 100 : null;

  const seated = w.filter((r) => r.seats_paid !== null && r.seats_paid > 0);
  const seatMonths = seated.reduce((n, r) => n + (r.seats_paid as number), 0);
  const ticketsPerSeat = seatMonths > 0 ? (seated.reduce((n, r) => n + r.tickets_linked, 0) / seatMonths) * 3 : null;

  return { daysToPay, onTimePct, remindersPerQuarter, rentPerSeat, seatUse, ticketsPerSeat };
}

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
  /** True for the bin holding this customer's figure. */
  mine: boolean;
}

export type Standing = "better" | "typical" | "worse";

export interface MeasureComparison {
  key: CompareMeasureKey;
  label: string;
  unit: string;
  better: MeasureDef["better"];
  note?: string;
  mine: number | null;
  peers: number;
  mean: number | null;
  median: number | null;
  /** Mine minus the center mean. */
  difference: number | null;
  /** 1 = best at the center (lowest for "lower", highest otherwise), out of `peers + 1`. */
  rank: number | null;
  standing: Standing | null;
  bins: HistogramBin[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function histogram(values: number[], mine: number | null): HistogramBin[] {
  const all = mine === null ? values : [...values, mine];
  if (all.length === 0) return [];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  if (lo === hi) return [{ from: lo, to: hi, count: values.length, mine: mine !== null }];
  const width = (hi - lo) / HISTOGRAM_BINS;
  const bins: HistogramBin[] = Array.from({ length: HISTOGRAM_BINS }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, count: 0, mine: false }));
  const at = (v: number) => Math.min(HISTOGRAM_BINS - 1, Math.floor((v - lo) / width));
  for (const v of values) bins[at(v)].count++;
  if (mine !== null) bins[at(mine)].mine = true;
  return bins;
}

export function compareMeasure(def: MeasureDef, mine: number | null, peerValues: number[], minPeers = COMPARE_MIN_PEERS): MeasureComparison {
  const mean = peerValues.length > 0 ? peerValues.reduce((a, b) => a + b, 0) / peerValues.length : null;
  let rank: number | null = null;
  let standing: Standing | null = null;
  if (mine !== null && peerValues.length > 0) {
    // Peers strictly ahead of this customer, so ties share a rank.
    const ahead = peerValues.filter((v) => (def.better === "lower" ? v < mine : v > mine)).length;
    rank = ahead + 1;
    if (def.better !== "none" && peerValues.length >= minPeers) {
      const worse = peerValues.filter((v) => (def.better === "lower" ? v > mine : v < mine)).length;
      const ties = peerValues.filter((v) => v === mine).length;
      const share = (worse + ties / 2) / peerValues.length;
      standing = share >= 2 / 3 ? "better" : share <= 1 / 3 ? "worse" : "typical";
    }
  }
  return {
    key: def.key,
    label: def.label,
    unit: def.unit,
    better: def.better,
    note: def.note,
    mine,
    peers: peerValues.length,
    mean,
    median: median(peerValues),
    difference: mine !== null && mean !== null ? mine - mean : null,
    rank,
    standing,
    bins: histogram(peerValues, mine),
  };
}

export interface TrendPoint {
  month: string;
  mine: number | null;
  center: number | null;
}

/** Average days to pay by month for this customer and for the other customers, weighted by invoices timed. */
export function daysToPayTrend(mine: CompareMonthRow[], peers: CompareMonthRow[], today: string, months = 12): TrendPoint[] {
  const out: TrendPoint[] = [];
  const todayIdx = monthIndex(today);
  const wavg = (rows: CompareMonthRow[]) => {
    const timed = rows.filter((r) => r.measured_count > 0 && r.avg_days_late !== null);
    const n = timed.reduce((s, r) => s + r.measured_count, 0);
    return n > 0 ? timed.reduce((s, r) => s + (r.avg_days_late as number) * r.measured_count, 0) / n : null;
  };
  for (let i = months - 1; i >= 0; i--) {
    const idx = todayIdx - i;
    const month = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}-01`;
    out.push({
      month,
      mine: wavg(mine.filter((r) => r.month === month)),
      center: wavg(peers.filter((r) => r.month === month)),
    });
  }
  return out;
}

export interface CompareResult {
  windowMonths: number;
  /** Customers at the center other than this one that had enough history to count. */
  peerCount: number;
  judged: boolean;
  measures: MeasureComparison[];
  trend: TrendPoint[];
}

/**
 * `rows` holds the monthly rows of this customer and everyone else at the
 * center. Peers with fewer than `minPeerMonths` rows are left out, as in scoring.
 */
export function buildComparison(leadId: string, rows: CompareMonthRow[], today: string, minPeerMonths = COMPARE_MIN_PEER_MONTHS): CompareResult {
  const byLead = new Map<string, CompareMonthRow[]>();
  for (const r of rows) {
    const list = byLead.get(r.lead_id) ?? [];
    list.push(r);
    byLead.set(r.lead_id, list);
  }
  const mineRows = byLead.get(leadId) ?? [];
  const peerRows: CompareMonthRow[] = [];
  const peerFigures: CustomerFigures[] = [];
  for (const [id, list] of byLead) {
    if (id === leadId || list.length < minPeerMonths) continue;
    peerRows.push(...list);
    peerFigures.push(customerFigures(list, today));
  }
  const mine = customerFigures(mineRows, today);
  const measures = COMPARE_MEASURES.map((def) =>
    compareMeasure(def, mine[def.key], peerFigures.flatMap((f) => (f[def.key] === null ? [] : [f[def.key] as number])))
  );
  return {
    windowMonths: COMPARE_WINDOW_MONTHS,
    peerCount: peerFigures.length,
    judged: peerFigures.length >= COMPARE_MIN_PEERS,
    measures,
    trend: daysToPayTrend(mineRows, peerRows, today),
  };
}

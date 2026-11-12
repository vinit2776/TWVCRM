/**
 * Customer Value scoring — the four pillars.
 *
 * Each function takes a customer's monthly metrics (the shape of the planned
 * `customer_value_monthly` table), an `asOf` month, and settings, and returns a
 * pillar score with a confidence figure and the per-metric breakdown behind it.
 * See docs/plans/customer-value-phase2.md, sections 2 and 3.
 *
 * Two kinds of "no value" are kept apart on purpose: a metric that should have
 * had data and did not is `missing` (it lowers confidence), while one that does
 * not apply, such as an SLA share for a customer with no tickets, is `na` and
 * is simply left out.
 *
 * Pure module: no database, no clock. Rows after `asOf` are never read.
 */

import type { EscalationOutcome } from "@/lib/customer-value/journey";
import {
  combineMetrics,
  clamp,
  missingMetric,
  notApplicableMetric,
  piecewiseScale,
  ruleMetric,
  scoreMetric,
  selectWindow,
  weightedMean,
  type MetricResult,
} from "@/lib/customer-value/scoring-primitives";
import {
  PILLAR_METRICS,
  type MetricKey,
  type PillarKey,
  type ScoringSettings,
} from "@/lib/customer-value/scoring-settings";

/** One customer's figures for one month. Same fields as the planned snapshot table. */
export interface MonthlyMetrics {
  /** First of the month, `YYYY-MM-01`. */
  month: string;
  revenue_ex_gst: number;
  invoiced_count: number;
  /** Average days late over the invoices that could be measured; null when none could. */
  avg_days_late: number | null;
  /** Invoices paid with a due date, so their timing could be measured. */
  measured_count: number;
  on_time_count: number;
  overdue_amount: number;
  max_days_overdue: number;
  reminders: number;
  concessions_counted: number;
  seats_paid: number | null;
  /** Average seats in use from door access; null where the center has no door data. */
  seats_used_avg: number | null;
  /** Monthly rent per seat before tax. */
  rent_per_seat: number | null;
  tickets_linked: number;
  tickets_sla_breached: number;
  tickets_reopened: number;
  satisfaction_avg: number | null;
  /** How many ratings `satisfaction_avg` is the mean of. */
  satisfaction_count: number;
  bookings: number;
  /** Null when billing queries were not available to count. */
  billing_queries: number | null;
}

/** One customer-month's margin after variable costs, from `customer_value_margin`. */
export interface MarginPoint {
  /** First of the month, `YYYY-MM-01`. */
  month: string;
  revenue: number;
  margin_after_variable: number;
  /** Share of that month's variable cost resting on measured data, 0 to 1; null when nothing was costed. */
  confidence: number | null;
}

/** Other customers' values for each metric, for percentile ranking. Never includes this customer. */
export type CohortValues = Partial<Record<MetricKey, number[]>>;

export interface PillarResult {
  pillar: PillarKey;
  /** 0 to 100, or null when nothing could be scored. */
  score: number | null;
  /** 0 to 1: how much of what should have been measured was. */
  confidence: number;
  metrics: MetricResult[];
  /** Plain-sentence caveats about this result (a cap applied, attribution too thin). */
  notes: string[];
  /** How many months of data fell inside the window. */
  monthsUsed: number;
}

export interface RenewalFacts {
  /** Renewals this customer completed. */
  renewed: number;
  /** Renewals this customer declined. */
  declined: number;
}

const HIGHER_IS_BETTER: Record<MetricKey, boolean> = {
  avg_days_late: false,
  on_time_share: true,
  overdue_ratio: false,
  reminders_per_invoice: false,
  tickets_per_seat_quarter: false,
  sla_breached_share: false,
  repeat_share: false,
  satisfaction_avg: true,
  billing_queries_per_quarter: false,
  seats_used_ratio: true,
  bookings_per_seat_month: true,
  seat_trend_pct: true,
  renewal_behaviour: true,
  concessions_pct: false,
  rent_vs_center: true,
  escalation_outcomes: true,
  margin_after_variable_pct: true,
};

/** Below this share of a center's tickets being attributable, ticket metrics are not trusted. */
const MIN_TICKET_LINK_COVERAGE = 0.5;

function scored(key: MetricKey, value: number | null, s: ScoringSettings, cohort: CohortValues): MetricResult {
  return scoreMetric({
    key,
    weight: s.metricWeights[key],
    value,
    higherIsBetter: HIGHER_IS_BETTER[key],
    scale: s.scales[key],
    cohort: cohort[key],
    cohortMin: s.cohortMin,
  });
}

function allMissing(pillar: PillarKey, s: ScoringSettings, notes: string[]): PillarResult {
  return {
    pillar,
    score: null,
    confidence: 0,
    metrics: PILLAR_METRICS[pillar].map((k) => missingMetric(k, s.metricWeights[k])),
    notes,
    monthsUsed: 0,
  };
}

function finish(pillar: PillarKey, metrics: MetricResult[], notes: string[], monthsUsed: number): PillarResult {
  const { score, confidence } = combineMetrics(metrics);
  return { pillar, score, confidence, metrics, notes, monthsUsed };
}

// ── Payment ─────────────────────────────────────────────────────────────

export function scorePayment(
  rows: MonthlyMetrics[],
  asOf: string,
  s: ScoringSettings,
  cohort: CohortValues = {}
): PillarResult {
  const win = selectWindow(rows, asOf, s.windowMonths, s.halfLifeMonths);
  const totalInvoices = win.reduce((n, x) => n + x.row.invoiced_count, 0);
  if (win.length === 0 || totalInvoices === 0) {
    return allMissing("payment", s, ["No invoices in the scoring window"]);
  }

  const daysLate = weightedMean(
    win.map((x) => ({
      value: x.row.measured_count > 0 ? x.row.avg_days_late : null,
      weight: x.weight * x.row.measured_count,
    }))
  );

  const measuredWeight = win.reduce((n, x) => n + x.weight * x.row.measured_count, 0);
  const onTime =
    measuredWeight > 0 ? win.reduce((n, x) => n + x.weight * x.row.on_time_count, 0) / measuredWeight : null;

  const newest = win[0].row;
  const avgRevenue = weightedMean(win.map((x) => ({ value: x.row.revenue_ex_gst, weight: x.weight })));
  const overdueRatio = avgRevenue !== null && avgRevenue > 0 ? newest.overdue_amount / avgRevenue : null;

  const invoiceWeight = win.reduce((n, x) => n + x.weight * x.row.invoiced_count, 0);
  const remindersPerInvoice =
    invoiceWeight > 0 ? win.reduce((n, x) => n + x.weight * x.row.reminders, 0) / invoiceWeight : null;

  const metrics = [
    scored("avg_days_late", daysLate, s, cohort),
    scored("on_time_share", onTime, s, cohort),
    scored("overdue_ratio", overdueRatio, s, cohort),
    scored("reminders_per_invoice", remindersPerInvoice, s, cohort),
  ];
  const result = finish("payment", metrics, [], win.length);

  // An invoice left this long unpaid is a problem no average can hide.
  if (result.score !== null && newest.max_days_overdue >= s.severeOverdueDays && result.score > s.severeOverdueCap) {
    result.score = s.severeOverdueCap;
    result.notes.push(`Capped at ${s.severeOverdueCap}: an invoice is ${newest.max_days_overdue} days overdue`);
  }
  return result;
}

// ── Friction ────────────────────────────────────────────────────────────

export function scoreFriction(
  rows: MonthlyMetrics[],
  asOf: string,
  s: ScoringSettings,
  cohort: CohortValues = {},
  /** Share of this center's tickets that could be tied to a customer, 0 to 1; null if unknown. */
  ticketLinkCoverage: number | null = null
): PillarResult {
  const win = selectWindow(rows, asOf, s.windowMonths, s.halfLifeMonths);
  if (win.length === 0) return allMissing("friction", s, ["No data in the scoring window"]);

  const notes: string[] = [];
  const lowCoverage = ticketLinkCoverage !== null && ticketLinkCoverage < MIN_TICKET_LINK_COVERAGE;
  if (lowCoverage) {
    notes.push(
      `Only ${Math.round((ticketLinkCoverage as number) * 100)}% of this center's tickets can be tied to a customer, so ticket measures are not scored`
    );
  }

  const seatsAvg = weightedMean(win.map((x) => ({ value: x.row.seats_paid, weight: x.weight })));
  const ticketsPerMonth = weightedMean(win.map((x) => ({ value: x.row.tickets_linked, weight: x.weight })));
  const ticketsPerSeatQuarter =
    !lowCoverage && seatsAvg !== null && seatsAvg > 0 && ticketsPerMonth !== null
      ? (ticketsPerMonth / seatsAvg) * 3
      : null;

  const totalTickets = win.reduce((n, x) => n + x.row.tickets_linked, 0);
  const ticketWeight = win.reduce((n, x) => n + x.weight * x.row.tickets_linked, 0);
  const share = (pick: (m: MonthlyMetrics) => number): number | null =>
    ticketWeight > 0 ? win.reduce((n, x) => n + x.weight * pick(x.row), 0) / ticketWeight : null;

  const ratedWeight = win.reduce((n, x) => n + x.weight * x.row.satisfaction_count, 0);
  const satisfaction =
    ratedWeight > 0
      ? win.reduce((n, x) => n + x.weight * (x.row.satisfaction_avg ?? 0) * x.row.satisfaction_count, 0) / ratedWeight
      : null;

  const queriesPerMonth = weightedMean(win.map((x) => ({ value: x.row.billing_queries, weight: x.weight })));

  const ticketMetric = (key: MetricKey, value: number | null): MetricResult => {
    if (lowCoverage) return missingMetric(key, s.metricWeights[key]);
    if (totalTickets === 0) return notApplicableMetric(key, s.metricWeights[key]);
    return scored(key, value, s, cohort);
  };

  const metrics = [
    scored("tickets_per_seat_quarter", ticketsPerSeatQuarter, s, cohort),
    ticketMetric("sla_breached_share", share((m) => m.tickets_sla_breached)),
    ticketMetric("repeat_share", share((m) => m.tickets_reopened)),
    ratedWeight > 0 ? scored("satisfaction_avg", satisfaction, s, cohort) : notApplicableMetric("satisfaction_avg", s.metricWeights.satisfaction_avg),
    scored("billing_queries_per_quarter", queriesPerMonth === null ? null : queriesPerMonth * 3, s, cohort),
  ];
  return finish("friction", metrics, notes, win.length);
}

// ── Engagement ──────────────────────────────────────────────────────────

export function scoreEngagement(
  rows: MonthlyMetrics[],
  asOf: string,
  s: ScoringSettings,
  cohort: CohortValues = {},
  renewal?: RenewalFacts
): PillarResult {
  const win = selectWindow(rows, asOf, s.windowMonths, s.halfLifeMonths);
  if (win.length === 0) return allMissing("engagement", s, ["No data in the scoring window"]);

  const withBoth = win.filter((x) => x.row.seats_used_avg !== null && (x.row.seats_paid ?? 0) > 0);
  const used = weightedMean(withBoth.map((x) => ({ value: x.row.seats_used_avg, weight: x.weight })));
  const paid = weightedMean(withBoth.map((x) => ({ value: x.row.seats_paid, weight: x.weight })));
  const usedRatio = used !== null && paid !== null && paid > 0 ? used / paid : null;

  const withSeats = win.filter((x) => (x.row.seats_paid ?? 0) > 0);
  const seatWeight = withSeats.reduce((n, x) => n + x.weight * (x.row.seats_paid ?? 0), 0);
  const bookingsPerSeat =
    seatWeight > 0 ? withSeats.reduce((n, x) => n + x.weight * x.row.bookings, 0) / seatWeight : null;

  // Seat trend: the newest month against the oldest in the window.
  const oldest = withSeats.length > 0 ? withSeats[withSeats.length - 1] : null;
  const newest = withSeats.length > 0 ? withSeats[0] : null;
  let seatTrend: MetricResult;
  if (oldest && newest && oldest !== newest && (oldest.row.seats_paid ?? 0) > 0) {
    const pct = (((newest.row.seats_paid ?? 0) - (oldest.row.seats_paid ?? 0)) / (oldest.row.seats_paid ?? 1)) * 100;
    seatTrend = {
      key: "seat_trend_pct",
      weight: s.metricWeights.seat_trend_pct,
      status: "ok",
      value: pct,
      score: clamp(piecewiseScale(pct, s.seatTrendPoints), 0, 100),
      method: "fixed",
      cohortSize: 0,
    };
  } else {
    seatTrend = notApplicableMetric("seat_trend_pct", s.metricWeights.seat_trend_pct);
  }

  let renewalMetric: MetricResult;
  if (renewal && renewal.declined > 0) renewalMetric = ruleMetric("renewal_behaviour", s.metricWeights.renewal_behaviour, 0);
  else if (renewal && renewal.renewed > 0) renewalMetric = ruleMetric("renewal_behaviour", s.metricWeights.renewal_behaviour, 100);
  else renewalMetric = notApplicableMetric("renewal_behaviour", s.metricWeights.renewal_behaviour);

  const notes: string[] = [];
  if (withBoth.length === 0) notes.push("No door-access data, so seats used cannot be measured");

  const metrics = [
    scored("seats_used_ratio", usedRatio, s, cohort),
    scored("bookings_per_seat_month", bookingsPerSeat, s, cohort),
    seatTrend,
    renewalMetric,
  ];
  return finish("engagement", metrics, notes, win.length);
}

// ── Profitability (revenue side) ────────────────────────────────────────

/**
 * Margin after variable costs over the window, recency-weighted and revenue-weighted so a quiet
 * month does not swing it. Null while the metric is off (weight zero), which leaves the pillar
 * exactly as it was. Not applicable, not missing, when there is no usable margin (none stored, or
 * every month below the measured-cost floor): absent cost data is not evidence of a poor margin.
 */
function marginMetric(points: MarginPoint[] | undefined, asOf: string, s: ScoringSettings, cohort: CohortValues): MetricResult | null {
  const weight = s.metricWeights.margin_after_variable_pct;
  if (!(weight > 0)) return null;
  // Only months where enough of the cost is measured: a month with no costed lines is not a margin, it is an absence of data.
  const usable = (points ?? []).filter((p) => p.confidence !== null && p.confidence >= s.marginMinConfidence);
  const win = selectWindow(usable, asOf, s.windowMonths, s.halfLifeMonths);
  const revenue = win.reduce((n, x) => n + x.weight * x.row.revenue, 0);
  if (win.length === 0 || !(revenue > 0)) return notApplicableMetric("margin_after_variable_pct", weight);
  const value = win.reduce((n, x) => n + x.weight * x.row.margin_after_variable, 0) / revenue;
  return scored("margin_after_variable_pct", value, s, cohort);
}

export function scoreProfitability(
  rows: MonthlyMetrics[],
  asOf: string,
  s: ScoringSettings,
  cohort: CohortValues = {},
  facts: { centerRentPerSeat?: number | null; escalations?: EscalationOutcome[]; margin?: MarginPoint[] } = {}
): PillarResult {
  const win = selectWindow(rows, asOf, s.windowMonths, s.halfLifeMonths);
  if (win.length === 0) return allMissing("profitability", s, ["No data in the scoring window"]);

  const revenueWeight = win.reduce((n, x) => n + x.weight * x.row.revenue_ex_gst, 0);
  const concessionsPct =
    revenueWeight > 0 ? (win.reduce((n, x) => n + x.weight * x.row.concessions_counted, 0) / revenueWeight) * 100 : null;

  const rent = weightedMean(win.map((x) => ({ value: x.row.rent_per_seat, weight: x.weight })));
  const center = facts.centerRentPerSeat ?? null;
  const rentVsCenter = rent !== null && center !== null && center > 0 ? rent / center : null;

  const known = (facts.escalations ?? []).filter((o): o is Exclude<EscalationOutcome, "unknown"> => o !== "unknown");
  const escalationMetric =
    known.length > 0
      ? ruleMetric(
          "escalation_outcomes",
          s.metricWeights.escalation_outcomes,
          known.reduce((n, o) => n + s.escalationScores[o], 0) / known.length
        )
      : notApplicableMetric("escalation_outcomes", s.metricWeights.escalation_outcomes);

  const margin = marginMetric(facts.margin, asOf, s, cohort);
  const metrics = [
    scored("concessions_pct", concessionsPct, s, cohort),
    scored("rent_vs_center", rentVsCenter, s, cohort),
    escalationMetric,
    ...(margin ? [margin] : []),
  ];
  const note = margin
    ? "Includes margin after variable costs, an estimate that rests on the cost rates entered"
    : "Revenue side only: real margin needs cost data";
  return finish("profitability", metrics, [note], win.length);
}

/**
 * Customer Value scoring — settings and defaults.
 *
 * Every number the scoring maths uses lives here, so tuning a weight, a tier
 * cut-off or a reference scale never means editing the formulas. Defaults are
 * the ones agreed in docs/plans/customer-value-phase2.md (decision D2). Later an
 * admin can override any of them through `app_settings`; `mergeSettings`
 * validates an override before it is used.
 *
 * Pure module: no database, no clock.
 */

export const PILLAR_KEYS = ["profitability", "payment", "engagement", "friction"] as const;
export type PillarKey = (typeof PILLAR_KEYS)[number];

export type MetricKey =
  // Payment
  | "avg_days_late"
  | "on_time_share"
  | "overdue_ratio"
  | "reminders_per_invoice"
  // Friction
  | "tickets_per_seat_quarter"
  | "sla_breached_share"
  | "repeat_share"
  | "satisfaction_avg"
  | "billing_queries_per_quarter"
  // Engagement
  | "seats_used_ratio"
  | "bookings_per_seat_month"
  | "seat_trend_pct"
  | "renewal_behaviour"
  // Profitability (revenue side)
  | "concessions_pct"
  | "rent_vs_center"
  | "escalation_outcomes"
  // Profitability (cost side): margin after variable costs. Only used when `margin.enabled` (off by default).
  | "margin_pct";

/** A straight line from `worst` (score 0) to `best` (score 100), clamped. Works in either direction. */
export interface ReferenceScale {
  best: number;
  worst: number;
}

export type Tier = "A" | "B" | "C" | "D";

export interface ScoringSettings {
  /** Weight of each pillar in the overall score. Renormalised over the pillars that qualify. */
  weights: Record<PillarKey, number>;
  /** Lowest overall score that earns each tier. Anything below `C` is a D. */
  tierCutoffs: { A: number; B: number; C: number };
  /** Months of history a score looks at. */
  windowMonths: number;
  /** A month this many months older counts half as much. */
  halfLifeMonths: number;
  /** Smallest cohort that is ranked by percentile; smaller ones use the reference scales. */
  cohortMin: number;
  /** A pillar below this share of its expected inputs is shown as low confidence and left out of the tier. */
  minPillarConfidence: number;
  /** A customer needs this many months of history before a tier is shown. */
  minTenureMonths: number;
  /** A tier needs at least this many confident pillars. */
  minConfidentPillars: number;
  /** Overall change, in points, that counts as a real move up or down. */
  trendThreshold: number;
  /** Weight of each metric inside its pillar. */
  metricWeights: Record<MetricKey, number>;
  /** Fixed reference scales, used when the cohort is too small to rank against. */
  scales: Partial<Record<MetricKey, ReferenceScale>>;
  /** Seat change over the window (percent) to score: shrinking loses points, growth earns them. */
  seatTrendPoints: Array<[changePct: number, score: number]>;
  /** Score for each escalation outcome on a renewal. */
  escalationScores: { accepted: number; reduced: number; avoided: number };
  /** An unpaid invoice this many days overdue caps the Payment pillar. */
  severeOverdueDays: number;
  severeOverdueCap: number;
  /**
   * Optional floor on any single pillar. When a pillar that counts toward the
   * tier scores below `below`, the tier cannot be better than `maxTier`. Without
   * it a customer who is always very late can still grade A, because Payment is
   * only one pillar in four. Null (the default) means no cap.
   */
  weakPillarCap: { below: number; maxTier: Tier } | null;
  /**
   * Margin after variable costs as a Profitability metric (phase 5, PR E). OFF by default: with
   * `enabled` false no score, tier or stored value changes. A month's margin only counts when at
   * least `minConfidence` of its cost rests on measured data, so a month where most costs are
   * unknown cannot rank customers against each other.
   */
  margin: { enabled: boolean; minConfidence: number };
}

export const DEFAULT_SCORING_SETTINGS: ScoringSettings = {
  weights: { profitability: 35, payment: 25, engagement: 20, friction: 20 },
  tierCutoffs: { A: 75, B: 60, C: 40 },
  windowMonths: 6,
  halfLifeMonths: 3,
  cohortMin: 8,
  minPillarConfidence: 0.5,
  minTenureMonths: 3,
  minConfidentPillars: 2,
  trendThreshold: 5,
  metricWeights: {
    avg_days_late: 40,
    on_time_share: 30,
    overdue_ratio: 20,
    reminders_per_invoice: 10,
    tickets_per_seat_quarter: 30,
    sla_breached_share: 20,
    repeat_share: 20,
    satisfaction_avg: 20,
    billing_queries_per_quarter: 10,
    seats_used_ratio: 40,
    bookings_per_seat_month: 20,
    seat_trend_pct: 20,
    renewal_behaviour: 20,
    concessions_pct: 50,
    rent_vs_center: 30,
    escalation_outcomes: 20,
    margin_pct: 40,
  },
  scales: {
    avg_days_late: { best: 0, worst: 15 },
    on_time_share: { best: 1, worst: 0.4 },
    overdue_ratio: { best: 0, worst: 1 },
    reminders_per_invoice: { best: 0, worst: 1 },
    tickets_per_seat_quarter: { best: 0, worst: 0.6 },
    sla_breached_share: { best: 0, worst: 0.5 },
    repeat_share: { best: 0, worst: 0.4 },
    satisfaction_avg: { best: 5, worst: 2 },
    billing_queries_per_quarter: { best: 0, worst: 3 },
    seats_used_ratio: { best: 0.8, worst: 0.3 },
    bookings_per_seat_month: { best: 1, worst: 0 },
    concessions_pct: { best: 0, worst: 15 },
    rent_vs_center: { best: 1.1, worst: 0.7 },
    // Margin after variable costs as a share of revenue: a first-cut range, to calibrate on real data.
    margin_pct: { best: 0.6, worst: 0.1 },
  },
  seatTrendPoints: [
    [-25, 0],
    [0, 60],
    [10, 100],
  ],
  escalationScores: { accepted: 100, reduced: 60, avoided: 20 },
  severeOverdueDays: 30,
  severeOverdueCap: 30,
  weakPillarCap: null,
  margin: { enabled: false, minConfidence: 0.5 },
};

/** Metric keys that belong to each pillar, in display order. */
export const PILLAR_METRICS: Record<PillarKey, MetricKey[]> = {
  payment: ["avg_days_late", "on_time_share", "overdue_ratio", "reminders_per_invoice"],
  friction: [
    "tickets_per_seat_quarter",
    "sla_breached_share",
    "repeat_share",
    "satisfaction_avg",
    "billing_queries_per_quarter",
  ],
  engagement: ["seats_used_ratio", "bookings_per_seat_month", "seat_trend_pct", "renewal_behaviour"],
  profitability: ["concessions_pct", "rent_vs_center", "escalation_outcomes"],
};

/**
 * Problems with a settings object, as plain sentences. Empty means usable.
 * Used before an admin override is accepted, so a typo cannot silently turn
 * every customer into a D.
 */
export function validateSettings(s: ScoringSettings): string[] {
  const problems: string[] = [];
  const positive = (n: number) => Number.isFinite(n) && n > 0;

  for (const k of PILLAR_KEYS) {
    if (!Number.isFinite(s.weights[k]) || s.weights[k] < 0) problems.push(`Pillar weight for ${k} must be zero or more`);
  }
  if (PILLAR_KEYS.every((k) => !(s.weights[k] > 0))) problems.push("At least one pillar weight must be above zero");

  const { A, B, C } = s.tierCutoffs;
  if (!(A > B && B > C && C > 0 && A <= 100)) problems.push("Tier cut-offs must fall in order: A above B above C, between 0 and 100");

  if (!positive(s.windowMonths) || !Number.isInteger(s.windowMonths)) problems.push("Window must be a whole number of months above zero");
  if (!positive(s.halfLifeMonths)) problems.push("Half-life must be above zero");
  if (!positive(s.cohortMin) || !Number.isInteger(s.cohortMin)) problems.push("Cohort minimum must be a whole number above zero");
  if (!(s.minPillarConfidence > 0 && s.minPillarConfidence <= 1)) problems.push("Minimum pillar confidence must be between 0 and 1");
  if (!(s.minConfidentPillars >= 1 && s.minConfidentPillars <= PILLAR_KEYS.length)) problems.push("Confident pillars needed must be between 1 and 4");
  if (!(s.minTenureMonths >= 0)) problems.push("Minimum tenure cannot be negative");
  if (!positive(s.trendThreshold)) problems.push("Trend threshold must be above zero");

  for (const [key, w] of Object.entries(s.metricWeights)) {
    if (!Number.isFinite(w) || w < 0) problems.push(`Metric weight for ${key} must be zero or more`);
  }
  for (const [key, scale] of Object.entries(s.scales)) {
    if (!scale || !Number.isFinite(scale.best) || !Number.isFinite(scale.worst) || scale.best === scale.worst) {
      problems.push(`Reference scale for ${key} needs two different numbers`);
    }
  }
  if (!(s.margin.minConfidence >= 0 && s.margin.minConfidence <= 1)) problems.push("Margin minimum confidence must be between 0 and 1");
  if (s.weakPillarCap) {
    const { below, maxTier } = s.weakPillarCap;
    if (!(below > 0 && below < 100)) problems.push("Weak pillar floor must be between 0 and 100");
    if (!["A", "B", "C", "D"].includes(maxTier)) problems.push("Weak pillar cap tier must be A, B, C or D");
  }
  const xs = s.seatTrendPoints.map((p) => p[0]);
  if (s.seatTrendPoints.length < 2 || xs.some((x, i) => i > 0 && x <= xs[i - 1])) {
    problems.push("Seat trend points need at least two points in increasing order");
  }
  return problems;
}

/**
 * Defaults with `overrides` laid over them, one level deep for the maps. Throws
 * if the result is not valid, so callers cannot accidentally score with it.
 */
export function mergeSettings(overrides: Partial<ScoringSettings> = {}): ScoringSettings {
  const merged: ScoringSettings = {
    ...DEFAULT_SCORING_SETTINGS,
    ...overrides,
    weights: { ...DEFAULT_SCORING_SETTINGS.weights, ...overrides.weights },
    tierCutoffs: { ...DEFAULT_SCORING_SETTINGS.tierCutoffs, ...overrides.tierCutoffs },
    metricWeights: { ...DEFAULT_SCORING_SETTINGS.metricWeights, ...overrides.metricWeights },
    scales: { ...DEFAULT_SCORING_SETTINGS.scales, ...overrides.scales },
    escalationScores: { ...DEFAULT_SCORING_SETTINGS.escalationScores, ...overrides.escalationScores },
    margin: { ...DEFAULT_SCORING_SETTINGS.margin, ...overrides.margin },
  };
  const problems = validateSettings(merged);
  if (problems.length > 0) throw new Error(`Invalid scoring settings: ${problems.join("; ")}`);
  return merged;
}

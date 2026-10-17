/**
 * Customer Value scoring — the arithmetic every pillar is built from.
 *
 * Small pure functions: percentile ranking within a cohort, fixed reference
 * scales, recency weighting, month windows, and combining metrics into a pillar
 * score with a confidence figure. See docs/plans/customer-value-phase2.md, section 3.
 *
 * Months are `YYYY-MM-01` strings. Nothing here reads a clock or a database;
 * `asOf` is always passed in, which is what makes backfilled history replayable.
 */

import type { MetricKey, ReferenceScale } from "@/lib/customer-value/scoring-settings";

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ── Scales ──────────────────────────────────────────────────────────────

/** `best` maps to 100 and `worst` to 0, linearly, clamped. Works whichever number is larger. */
export function linearScale(value: number, scale: ReferenceScale): number {
  if (scale.best === scale.worst) return 100;
  const t = (value - scale.worst) / (scale.best - scale.worst);
  return clamp(t, 0, 1) * 100;
}

/** Interpolates between (x, score) points; flat beyond the first and last point. */
export function piecewiseScale(value: number, points: Array<[number, number]>): number {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  if (value <= sorted[0][0]) return sorted[0][1];
  const last = sorted[sorted.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < sorted.length; i++) {
    const [x1, y1] = sorted[i];
    if (value <= x1) {
      const [x0, y0] = sorted[i - 1];
      return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

/**
 * Where `value` sits among the cohort, 0 to 100 (100 = better than everyone).
 * Ties count half. The cohort must NOT include the customer being scored.
 * Null when the cohort has no usable numbers.
 */
export function percentileScore(value: number, cohort: number[], higherIsBetter: boolean): number | null {
  const others = cohort.filter((v) => Number.isFinite(v));
  if (others.length === 0) return null;
  let worse = 0;
  let equal = 0;
  for (const v of others) {
    if (v === value) equal++;
    else if (higherIsBetter ? v < value : v > value) worse++;
  }
  return ((worse + 0.5 * equal) / others.length) * 100;
}

// ── Time ────────────────────────────────────────────────────────────────

/** A running month number, so months can be subtracted. Accepts `YYYY-MM` or `YYYY-MM-DD`. */
export function monthIndex(ymd: string): number {
  const [y, m] = ymd.slice(0, 7).split("-").map(Number);
  return y * 12 + (m - 1);
}

/** Whole months from `a` to `b` (positive when b is later). */
export function monthsBetween(a: string, b: string): number {
  return monthIndex(b) - monthIndex(a);
}

/** How much a month `monthsAgo` months old counts: 1 now, half after one half-life, and so on. */
export function recencyWeight(monthsAgo: number, halfLifeMonths: number): number {
  return Math.pow(0.5, Math.max(0, monthsAgo) / halfLifeMonths);
}

export interface WindowedRow<T> {
  row: T;
  monthsAgo: number;
  /** Recency weight for this month. */
  weight: number;
}

/**
 * The rows inside the scoring window, newest first, with their age and recency
 * weight. Rows after `asOf` are ignored: a score as of a past date must never
 * see what happened later, which is what makes a backfill honest.
 */
export function selectWindow<T extends { month: string }>(
  rows: T[],
  asOf: string,
  windowMonths: number,
  halfLifeMonths: number
): Array<WindowedRow<T>> {
  const out: Array<WindowedRow<T>> = [];
  for (const row of rows) {
    const monthsAgo = monthsBetween(row.month, asOf);
    if (monthsAgo < 0 || monthsAgo >= windowMonths) continue;
    out.push({ row, monthsAgo, weight: recencyWeight(monthsAgo, halfLifeMonths) });
  }
  return out.sort((a, b) => a.monthsAgo - b.monthsAgo);
}

/** Σ(value × weight) ÷ Σ weight over the items that have a value; null when there are none. */
export function weightedMean(items: Array<{ value: number | null; weight: number }>): number | null {
  let num = 0;
  let den = 0;
  for (const it of items) {
    if (it.value === null || !Number.isFinite(it.value) || !(it.weight > 0)) continue;
    num += it.value * it.weight;
    den += it.weight;
  }
  return den > 0 ? num / den : null;
}

// ── Metrics and pillars ─────────────────────────────────────────────────

/**
 * ok      the metric has a value and was scored
 * missing it should have had data and does not: lowers the pillar's confidence
 * na      it does not apply (for example no tickets means no SLA share to judge):
 *         left out without lowering confidence
 */
export type MetricStatus = "ok" | "missing" | "na";

export type MetricMethod = "percentile" | "fixed" | "rule";

export interface MetricResult {
  key: MetricKey;
  weight: number;
  status: MetricStatus;
  /** The measured value, in the metric's own unit. Null when missing or not applicable. */
  value: number | null;
  /** 0 to 100, or null unless status is "ok". */
  score: number | null;
  method: MetricMethod | null;
  cohortSize: number;
}

export function missingMetric(key: MetricKey, weight: number): MetricResult {
  return { key, weight, status: "missing", value: null, score: null, method: null, cohortSize: 0 };
}

export function notApplicableMetric(key: MetricKey, weight: number): MetricResult {
  return { key, weight, status: "na", value: null, score: null, method: null, cohortSize: 0 };
}

/** A metric whose value is already a 0 to 100 score (renewal behaviour, escalation outcomes). */
export function ruleMetric(key: MetricKey, weight: number, score: number): MetricResult {
  return { key, weight, status: "ok", value: score, score: clamp(score, 0, 100), method: "rule", cohortSize: 0 };
}

export interface ScoreMetricOptions {
  key: MetricKey;
  weight: number;
  value: number | null;
  higherIsBetter: boolean;
  scale: ReferenceScale | undefined;
  /** Other customers' values for this metric (excluding this customer). */
  cohort: number[] | undefined;
  cohortMin: number;
}

/**
 * Scores one metric: by percentile within the cohort when the cohort is big
 * enough, otherwise against the fixed reference scale. The result records which.
 */
export function scoreMetric(opts: ScoreMetricOptions): MetricResult {
  const { key, weight, value, higherIsBetter, scale, cohort, cohortMin } = opts;
  if (value === null || !Number.isFinite(value)) return missingMetric(key, weight);

  const usable = (cohort ?? []).filter((v) => Number.isFinite(v));
  if (usable.length >= cohortMin) {
    const score = percentileScore(value, usable, higherIsBetter);
    if (score !== null) return { key, weight, status: "ok", value, score, method: "percentile", cohortSize: usable.length };
  }
  if (!scale) return missingMetric(key, weight);
  return { key, weight, status: "ok", value, score: linearScale(value, scale), method: "fixed", cohortSize: usable.length };
}

export interface CombinedMetrics {
  /** Weighted mean of the scored metrics, or null when none could be scored. */
  score: number | null;
  /**
   * Weight of the metrics that were scored ÷ weight of the ones that should have
   * been. Not-applicable metrics are left out of both. Zero when nothing could
   * be judged.
   */
  confidence: number;
}

export function combineMetrics(metrics: MetricResult[]): CombinedMetrics {
  let scored = 0;
  let scoredWeighted = 0;
  let missing = 0;
  for (const m of metrics) {
    if (m.status === "ok" && m.score !== null) {
      scored += m.weight;
      scoredWeighted += m.weight * m.score;
    } else if (m.status === "missing") {
      missing += m.weight;
    }
  }
  if (scored <= 0) return { score: null, confidence: 0 };
  return { score: scoredWeighted / scored, confidence: scored / (scored + missing) };
}

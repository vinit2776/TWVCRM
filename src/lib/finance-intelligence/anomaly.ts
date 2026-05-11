/**
 * Statistical helpers for anomaly detection.
 *
 * Used by the amount-anomaly feature ("this bill is 3.2× larger than
 * usual for this vendor"). Deliberately conservative — we'd rather
 * miss small anomalies than annoy accountants with false alarms.
 */

import { average } from "./suggest";

export interface AnomalyResult {
  is_anomaly: boolean;
  reason?: string;              // human-readable, e.g. "3.2× the rolling average"
  ratio?: number;               // observed / expected
  z_score?: number;
  baseline_average?: number;
  baseline_count?: number;
}

/**
 * Detect if `value` is an outlier vs `history`.
 *
 * Rules (must satisfy both to flag):
 *   - Sample size ≥ 3 (otherwise we have no baseline)
 *   - Either: value > avg + 2σ   OR   value > 3 × avg (whichever stricter)
 *
 * Returns reasoning that's safe to show to a non-technical operator.
 */
export function detectAmountAnomaly(value: number, history: number[]): AnomalyResult {
  if (history.length < 3) {
    return { is_anomaly: false, baseline_count: history.length };
  }

  const avg = average(history);
  if (avg <= 0) return { is_anomaly: false, baseline_count: history.length };

  const variance = average(history.map((v) => (v - avg) ** 2));
  const stdDev = Math.sqrt(variance);
  const zScore = stdDev > 0 ? (value - avg) / stdDev : 0;
  const ratio = value / avg;

  const exceedsSigma = zScore > 2;
  const exceedsTriple = ratio > 3;

  if (!exceedsSigma || !exceedsTriple) {
    return {
      is_anomaly: false,
      ratio,
      z_score: zScore,
      baseline_average: avg,
      baseline_count: history.length,
    };
  }

  // Construct a human-readable reason
  let reason: string;
  if (ratio >= 5) reason = `${ratio.toFixed(1)}× the vendor's typical amount`;
  else if (ratio >= 3) reason = `${ratio.toFixed(1)}× the vendor's rolling average`;
  else reason = `${zScore.toFixed(1)}σ above the vendor's typical spend`;

  return {
    is_anomaly: true,
    reason,
    ratio,
    z_score: zScore,
    baseline_average: avg,
    baseline_count: history.length,
  };
}

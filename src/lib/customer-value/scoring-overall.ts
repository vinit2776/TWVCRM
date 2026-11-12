/**
 * Customer Value scoring — overall score, tier and trend.
 *
 * Combines the four pillar results into one score and an A to D tier, with the
 * rules that stop a thin or brand-new customer being judged: a tier needs
 * enough history and at least two pillars the data actually supports.
 * See docs/plans/customer-value-phase2.md, section 3.
 *
 * Pure module: no database, no clock.
 */

import type { EscalationOutcome } from "@/lib/customer-value/journey";
import {
  scoreEngagement,
  scoreFriction,
  scorePayment,
  scoreProfitability,
  type CohortValues,
  type MarginPoint,
  type MonthlyMetrics,
  type PillarResult,
  type RenewalFacts,
} from "@/lib/customer-value/scoring-pillars";
import {
  DEFAULT_SCORING_SETTINGS,
  PILLAR_KEYS,
  type PillarKey,
  type ScoringSettings,
  type Tier,
} from "@/lib/customer-value/scoring-settings";

export type ScoreStatus = "graded" | "not_enough_data";

export type Trend = "up" | "down" | "flat";

export interface CustomerScoreInput {
  /** The customer's monthly figures. Months after `asOf` are ignored. */
  rows: MonthlyMetrics[];
  /** Months since the first contract started, as of `asOf`. Null if never active. */
  tenureMonths: number | null;
  /** Share of the center's tickets that could be tied to a customer, 0 to 1; null if unknown. */
  ticketLinkCoverage?: number | null;
  renewal?: RenewalFacts;
  centerRentPerSeat?: number | null;
  escalations?: EscalationOutcome[];
  /** Margin after variable costs by month; read only when its metric weight is above zero. */
  margin?: MarginPoint[];
  /** Other customers' values per metric, for percentile ranking. */
  cohort?: CohortValues;
}

export interface CustomerScore {
  asOf: string;
  pillars: Record<PillarKey, PillarResult>;
  /** Null unless the customer could be graded. */
  overall: number | null;
  /** Null unless the customer could be graded. */
  tier: Tier | null;
  status: ScoreStatus;
  /** Why there is no tier, in a plain sentence. Null when graded. */
  reason: string | null;
  /** Pillars that met the confidence bar and so fed the overall score. */
  confidentPillars: PillarKey[];
  /** The weight each pillar actually carried after renormalising; zero for any left out. */
  weightsUsed: Record<PillarKey, number>;
  /**
   * Set only when the weak-pillar cap actually lowered the tier: which pillar
   * triggered it and the best tier it now allows. Null otherwise.
   */
  tierCap: { pillar: PillarKey; maxTier: Tier } | null;
}

/** The tier a score earns. */
export function tierFor(overall: number, cutoffs: ScoringSettings["tierCutoffs"]): Tier {
  if (overall >= cutoffs.A) return "A";
  if (overall >= cutoffs.B) return "B";
  if (overall >= cutoffs.C) return "C";
  return "D";
}

const TIER_ORDER: Tier[] = ["A", "B", "C", "D"];

/** The worse of two tiers. */
function worseTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * Direction of travel between two overall scores. Null when either is missing
 * (a customer who could not be graded then has no trend to show).
 */
export function trendBetween(current: number | null, previous: number | null, threshold: number): Trend | null {
  if (current === null || previous === null) return null;
  const change = current - previous;
  if (change >= threshold) return "up";
  if (change <= -threshold) return "down";
  return "flat";
}

/**
 * Scores one customer as of one month. Everything it reads comes from `input`
 * and everything it ignores (rows after `asOf`) is ignored by the pillar
 * functions, so running it for a past month reproduces what was knowable then.
 */
export function scoreCustomer(
  input: CustomerScoreInput,
  asOf: string,
  settings: ScoringSettings = DEFAULT_SCORING_SETTINGS
): CustomerScore {
  const cohort = input.cohort ?? {};
  const pillars: Record<PillarKey, PillarResult> = {
    payment: scorePayment(input.rows, asOf, settings, cohort),
    friction: scoreFriction(input.rows, asOf, settings, cohort, input.ticketLinkCoverage ?? null),
    engagement: scoreEngagement(input.rows, asOf, settings, cohort, input.renewal),
    profitability: scoreProfitability(input.rows, asOf, settings, cohort, {
      centerRentPerSeat: input.centerRentPerSeat,
      escalations: input.escalations,
      margin: input.margin,
    }),
  };

  const confidentPillars = PILLAR_KEYS.filter(
    (k) => pillars[k].score !== null && pillars[k].confidence >= settings.minPillarConfidence && settings.weights[k] > 0
  );

  const weightTotal = confidentPillars.reduce((n, k) => n + settings.weights[k], 0);
  const weightsUsed = Object.fromEntries(
    PILLAR_KEYS.map((k) => [k, confidentPillars.includes(k) && weightTotal > 0 ? settings.weights[k] / weightTotal : 0])
  ) as Record<PillarKey, number>;

  let reason: string | null = null;
  if (input.tenureMonths === null || input.tenureMonths < settings.minTenureMonths) {
    reason = `Under ${settings.minTenureMonths} months of history`;
  } else if (confidentPillars.length < settings.minConfidentPillars) {
    reason = `Only ${confidentPillars.length} of 4 measures have enough data (needs ${settings.minConfidentPillars})`;
  }

  if (reason !== null) {
    return {
      asOf,
      pillars,
      overall: null,
      tier: null,
      status: "not_enough_data",
      reason,
      confidentPillars,
      weightsUsed,
      tierCap: null,
    };
  }

  const overall = confidentPillars.reduce((n, k) => n + (pillars[k].score as number) * weightsUsed[k], 0);
  let tier = tierFor(overall, settings.tierCutoffs);

  // A pillar that is far too weak limits the tier however strong the rest is.
  let tierCap: CustomerScore["tierCap"] = null;
  const cap = settings.weakPillarCap;
  if (cap) {
    const weakest = confidentPillars
      .filter((k) => (pillars[k].score as number) < cap.below)
      .sort((a, b) => (pillars[a].score as number) - (pillars[b].score as number))[0];
    if (weakest) {
      const capped = worseTier(tier, cap.maxTier);
      if (capped !== tier) {
        tier = capped;
        tierCap = { pillar: weakest, maxTier: cap.maxTier };
      }
    }
  }

  return { asOf, pillars, overall, tier, status: "graded", reason: null, confidentPillars, weightsUsed, tierCap };
}

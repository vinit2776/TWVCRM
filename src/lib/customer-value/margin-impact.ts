/**
 * Customer Value — what turning margin scoring on would change.
 *
 * Scores every customer twice on the same date with the same everything else,
 * once as scoring stands (margin ignored) and once with margin counted in
 * Profitability, and reports who moves. Pure: the caller loads the customers
 * (with their margins). It writes nothing; it exists so the switch is made with the
 * numbers in front of you, not hoped about.
 */

import { scoreCustomersAt, type RunCustomer } from "@/lib/customer-value/scoring-run";
import type { ScoringSettings, Tier } from "@/lib/customer-value/scoring-settings";

export interface ImpactMover {
  leadId: string;
  tierBefore: Tier | null;
  tierAfter: Tier | null;
  overallBefore: number | null;
  overallAfter: number | null;
  profitabilityBefore: number | null;
  profitabilityAfter: number | null;
}

export interface MarginImpact {
  asOf: string;
  customers: number;
  /** Customers with at least one month of margin usable under the confidence floor. */
  withUsableMargin: number;
  tierChanged: number;
  tierUp: number;
  tierDown: number;
  /** "B -> C": how many moved between each pair of tiers (a missing tier is "none"). */
  transitions: Record<string, number>;
  /** Customers whose Profitability pillar moved by at least `pillarMoveThreshold` points. */
  pillarMoved: number;
  /** Largest overall-score moves first, whether or not the tier changed. */
  movers: ImpactMover[];
}

const TIER_ORDER: Record<Tier, number> = { A: 0, B: 1, C: 2, D: 3 };
const PILLAR_MOVE_THRESHOLD = 5;

export function compareMarginImpact(customers: RunCustomer[], asOf: string, settings: ScoringSettings, topMovers = 30): MarginImpact {
  const off = scoreCustomersAt(customers, [asOf], { ...settings, margin: { ...settings.margin, enabled: false } });
  const on = scoreCustomersAt(customers, [asOf], { ...settings, margin: { ...settings.margin, enabled: true } });

  const movers: ImpactMover[] = [];
  const transitions: Record<string, number> = {};
  let tierChanged = 0;
  let tierUp = 0;
  let tierDown = 0;
  let pillarMoved = 0;

  for (const c of customers) {
    const before = off.get(c.leadId)?.find((s) => s.asOf === asOf)?.score;
    const after = on.get(c.leadId)?.find((s) => s.asOf === asOf)?.score;
    if (!before || !after) continue;

    if (before.tier !== after.tier) {
      tierChanged++;
      const key = `${before.tier ?? "none"} -> ${after.tier ?? "none"}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
      if (before.tier && after.tier) {
        if (TIER_ORDER[after.tier] < TIER_ORDER[before.tier]) tierUp++;
        else tierDown++;
      }
    }
    const pb = before.pillars.profitability.score;
    const pa = after.pillars.profitability.score;
    if (pb !== null && pa !== null && Math.abs(pa - pb) >= PILLAR_MOVE_THRESHOLD) pillarMoved++;

    movers.push({
      leadId: c.leadId,
      tierBefore: before.tier,
      tierAfter: after.tier,
      overallBefore: before.overall,
      overallAfter: after.overall,
      profitabilityBefore: pb,
      profitabilityAfter: pa,
    });
  }

  const usable = customers.filter((c) => (c.margins ?? []).some((m) => m.margin_pct !== null && m.confidence !== null && m.confidence >= settings.margin.minConfidence)).length;
  const size = (m: ImpactMover) => Math.abs((m.overallAfter ?? 0) - (m.overallBefore ?? 0));
  movers.sort((a, b) => size(b) - size(a));

  return { asOf, customers: customers.length, withUsableMargin: usable, tierChanged, tierUp, tierDown, transitions, pillarMoved, movers: movers.slice(0, topMovers) };
}

/**
 * Customer Value — what turning on the margin metric would do
 * (docs/plans/customer-value-phase5-cost-simulator.md, PR E).
 *
 * Scores every customer today twice from the same loaded data: once as scoring is
 * now, once with margin after variable costs given a weight inside Profitability.
 * Nothing is written and no setting is changed; it only reports who would move,
 * so the switch is made knowing its effect.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listCustomerIds, loadMarginPoints } from "@/lib/customer-value/scores-refresh";
import { scoreCustomersAt, type RunCustomer } from "@/lib/customer-value/scoring-run";
import { SCORING_SETTINGS_KEY, loadSettings } from "@/lib/customer-value/scoring-settings-store";
import { validateSettings, type ScoringSettings, type Tier } from "@/lib/customer-value/scoring-settings";
import { loadCustomers } from "@/lib/customer-value/snapshot-load";
import type { CustomerScore } from "@/lib/customer-value/scoring-overall";

export interface PreviewChange {
  leadId: string;
  from: Tier | null;
  to: Tier | null;
  overallFrom: number | null;
  overallTo: number | null;
  profitabilityFrom: number | null;
  profitabilityTo: number | null;
}

export interface MarginPreview {
  today: string;
  /** The weight tried for margin inside Profitability. */
  weight: number;
  customers: number;
  /** Customers with a stored margin month inside the scoring window that clears the measured-cost floor. */
  withMargin: number;
  /** Customers whose Profitability score would change at all. */
  profitabilityChanged: number;
  /** Tier moves, best first by size of move. */
  tierChanges: PreviewChange[];
  counts: { unchanged: number; up: number; down: number; gainedTier: number; lostTier: number };
  warnings: string[];
}

const ORDER: Record<Tier, number> = { A: 3, B: 2, C: 1, D: 0 };

/** Pure: compares two scorings of the same customers. */
export function comparePreview(base: Map<string, CustomerScore>, withMargin: Map<string, CustomerScore>): Pick<MarginPreview, "tierChanges" | "counts" | "profitabilityChanged"> {
  const tierChanges: PreviewChange[] = [];
  const counts = { unchanged: 0, up: 0, down: 0, gainedTier: 0, lostTier: 0 };
  let profitabilityChanged = 0;
  for (const [leadId, a] of base) {
    const b = withMargin.get(leadId);
    if (!b) continue;
    if ((a.pillars.profitability.score ?? null) !== (b.pillars.profitability.score ?? null)) profitabilityChanged++;
    if (a.tier === b.tier) {
      counts.unchanged++;
      continue;
    }
    if (a.tier === null) counts.gainedTier++;
    else if (b.tier === null) counts.lostTier++;
    else if (ORDER[b.tier] > ORDER[a.tier]) counts.up++;
    else counts.down++;
    tierChanges.push({
      leadId,
      from: a.tier,
      to: b.tier,
      overallFrom: a.overall,
      overallTo: b.overall,
      profitabilityFrom: a.pillars.profitability.score,
      profitabilityTo: b.pillars.profitability.score,
    });
  }
  tierChanges.sort((x, y) => Math.abs((y.overallTo ?? 0) - (y.overallFrom ?? 0)) - Math.abs((x.overallTo ?? 0) - (x.overallFrom ?? 0)));
  return { tierChanges, counts, profitabilityChanged };
}

export async function previewMarginScoring(supabase: SupabaseClient, today: string, weight: number): Promise<MarginPreview> {
  const warnings: string[] = [];
  const { data: settingRow } = await supabase.from("app_settings").select("value").eq("key", SCORING_SETTINGS_KEY).maybeSingle();
  const loaded = loadSettings((settingRow as { value?: string } | null)?.value ?? null);
  if (loaded.warning) warnings.push(loaded.warning);

  const base: ScoringSettings = { ...loaded.settings, metricWeights: { ...loaded.settings.metricWeights, margin_after_variable_pct: 0 } };
  const trial: ScoringSettings = { ...loaded.settings, metricWeights: { ...loaded.settings.metricWeights, margin_after_variable_pct: weight } };
  const problems = validateSettings(trial);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const ids = await listCustomerIds(supabase);
  const [assembled, margin] = await Promise.all([loadCustomers(supabase, ids), loadMarginPoints(supabase, ids)]);
  const customers: RunCustomer[] = ids
    .map((id) => assembled.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => ({ leadId: c.leadId, raw: c.raw, locationIds: c.locationIds, ticketLinkCoverage: c.ticketLinkCoverage, margin: margin.get(c.leadId) }));

  const pick = (scored: ReturnType<typeof scoreCustomersAt>) => new Map([...scored].map(([leadId, list]) => [leadId, list[0].score]));
  const baseScores = pick(scoreCustomersAt(customers, [today], base));
  const trialScores = pick(scoreCustomersAt(customers, [today], trial));
  const cmp = comparePreview(baseScores, trialScores);

  const windowStart = new Date(Date.parse(`${today}T00:00:00Z`) - base.windowMonths * 31 * 86_400_000).toISOString().slice(0, 7);
  const withMargin = customers.filter((c) => (c.margin ?? []).some((m) => m.month.slice(0, 7) >= windowStart && m.revenue > 0 && m.confidence !== null && m.confidence >= base.marginMinConfidence)).length;
  if (withMargin === 0) warnings.push(`No customer has a month with at least ${Math.round(base.marginMinConfidence * 100)}% of its cost measured yet, so nothing can change. Margin is filled by the nightly job, and enter your cost rates so more of it counts.`);

  return { today, weight, customers: customers.length, withMargin, ...cmp, warnings };
}

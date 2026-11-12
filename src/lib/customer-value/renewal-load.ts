/**
 * Loading the renewal outlook and cross-pillar insights for one customer
 * (docs/plans/customer-value-phase6-portfolio.md): stored figures and the
 * customer's own contracts, with the break-even rent from the Costs tab's cost
 * base. A figure that cannot be worked out is left out, never guessed. Read only;
 * callers must have checked the user is an admin (the cost base reads the lease).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { INSIGHT_THRESHOLDS, buildInsights, type Insight } from "@/lib/customer-value/insights";
import { buildJourney } from "@/lib/customer-value/journey";
import { loadCostsBase } from "@/lib/customer-value/costs-load";
import { simulate } from "@/lib/customer-value/cost-simulator";
import { loadLeadContracts } from "@/lib/customer-value/load-contracts";
import { buildRenewalOutlook, type RenewalOutlook } from "@/lib/customer-value/renewal-outlook";
import { summariseShadow, type ShadowRow } from "@/lib/customer-value/shadow-margin";
import type { StoredScoreRow } from "@/lib/customer-value/summary-view";

const DAY_MS = 86_400_000;
const PREVIOUS_WINDOW_DAYS = 15;

const SCORE_COLUMNS = "as_of, payment, friction, engagement, profitability, confidence, overall, tier, status, reason, trend_vs_90d, method, story, settings_version, computed_at";

const ymdMinus = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export interface RenewalLoad {
  today: string;
  outlook: RenewalOutlook;
  insights: Insight[];
}

/** Null when the lead does not exist. */
export async function loadRenewalOutlook(supabase: SupabaseClient, leadId: string, today: string): Promise<RenewalLoad | null> {
  const target = ymdMinus(today, 90);

  const [leadRes, loaded, latestRes, previousRes, marginRes, costs] = await Promise.all([
    supabase.from("leads").select("created_at, source").eq("id", leadId).maybeSingle(),
    loadLeadContracts(supabase, leadId),
    supabase.from("customer_value_scores").select(SCORE_COLUMNS).eq("lead_id", leadId).order("as_of", { ascending: false }).limit(1).returns<StoredScoreRow[]>(),
    supabase
      .from("customer_value_scores")
      .select(SCORE_COLUMNS)
      .eq("lead_id", leadId)
      .gte("as_of", ymdMinus(target, PREVIOUS_WINDOW_DAYS))
      .lte("as_of", ymdMinus(target, -PREVIOUS_WINDOW_DAYS))
      .returns<StoredScoreRow[]>(),
    supabase
      .from("customer_value_margin")
      .select("month, revenue, variable_cost, margin_after_variable, confidence")
      .eq("lead_id", leadId)
      .order("month", { ascending: false })
      .limit(3)
      .returns<Array<{ month: string; revenue: number | string; variable_cost: number | string; margin_after_variable: number | string; confidence: number | string | null }>>(),
    // A failure here only costs the break-even line, never the rest of the card.
    loadCostsBase(supabase, leadId, today).catch((err) => {
      console.error("[api/leads/value/renewal] costs unavailable:", err instanceof Error ? err.message : err);
      return null;
    }),
  ]);
  if (leadRes.error || "error" in loaded || latestRes.error || previousRes.error) {
    throw new Error(leadRes.error?.message ?? ("error" in loaded ? loaded.error : (latestRes.error ?? previousRes.error)?.message ?? ""));
  }
  if (!leadRes.data) return null;
  // Margin is optional context: a failed read leaves it out rather than losing the card.
  const marginRows: ShadowRow[] = marginRes.error
    ? []
    : (marginRes.data ?? []).map((r) => ({ month: r.month, revenue: Number(r.revenue), variable_cost: Number(r.variable_cost), margin_after_variable: Number(r.margin_after_variable), confidence: r.confidence === null ? null : Number(r.confidence) }));

  const journey = buildJourney({ lead: { created_at: leadRes.data.created_at, source: leadRes.data.source ?? null }, contracts: loaded.contracts, today });
  const current = journey.current;
  const currentContract = current ? loaded.contracts.find((c) => c.contract_number === current.contractNumber) : undefined;
  const step = current
    ? [...journey.rentSteps].filter((s) => s.contractNumber === current.contractNumber && s.from <= today && s.perSeat !== null).sort((a, b) => (a.from < b.from ? 1 : -1))[0]
    : undefined;

  const breakEven = costs && costs.status === "ok" && costs.base && costs.params ? simulate(costs.base, costs.params).breakEvenFullyLoaded : null;
  const outcomes = journey.escalations.map((e) => e.outcome);

  const outlook = buildRenewalOutlook({
    current: current ? { contractNumber: current.contractNumber, endDate: current.endDate, daysToEnd: current.daysToEnd, renewalDraftStatus: current.renewalDraftStatus } : null,
    standingEscalationPct: currentContract?.escalation_percentage === null || currentContract?.escalation_percentage === undefined ? null : Number(currentContract.escalation_percentage),
    renewalCount: journey.renewalCount,
    renewalsDeclined: journey.renewalsDeclined,
    escalationOutcomes: outcomes,
    rentPerSeat: step?.perSeat ?? null,
    breakEvenRentPerSeat: breakEven,
    urgentWithinDays: INSIGHT_THRESHOLDS.renewingWithinDays,
  });

  const latest = latestRes.data?.[0] ?? null;
  const previous = (previousRes.data ?? []).sort((a, b) => Math.abs(daysBetween(target, a.as_of)) - Math.abs(daysBetween(target, b.as_of)))[0] ?? null;
  const shadow = summariseShadow(marginRows);
  const insights = buildInsights({
    latest,
    previous,
    marginPerMonth: shadow ? shadow.marginPerMonth : null,
    daysToRenewal: current ? current.daysToEnd : null,
    pushedBackOnEscalation: outcomes.some((o) => o === "reduced" || o === "avoided"),
  });

  return { today, outlook, insights };
}

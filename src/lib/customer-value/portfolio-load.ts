/**
 * Customer Value — loading the portfolio
 * (docs/plans/customer-value-phase6-portfolio.md, section 2.1).
 *
 * One row per customer from stored figures only: the latest score, the score
 * about 90 days earlier, the shadow margin, and the contracts (for the center,
 * the live contract's end date, and earlier escalation outcomes). Nothing is
 * aggregated over live invoices or tickets. Read only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { chooseServiceCenter, type ContractLocation } from "@/lib/customer-value/center-cohort";
import { buildInsights } from "@/lib/customer-value/insights";
import { classifyEscalation } from "@/lib/customer-value/journey";
import { change90, type PortfolioRow, type PortfolioTier } from "@/lib/customer-value/portfolio-view";
import { fetchAllPages, fetchInChunks } from "@/lib/customer-value/query-helpers";
import { summariseShadow, type ShadowRow } from "@/lib/customer-value/shadow-margin";
import type { StoredScoreRow } from "@/lib/customer-value/summary-view";

const DAY_MS = 86_400_000;
const LIVE = ["active", "renewal_in_progress"];
/** How far either side of "90 days ago" a score may sit and still count as the earlier one. */
const PREVIOUS_WINDOW_DAYS = 15;

interface ContractRow extends ContractLocation {
  end_date: string;
  escalation_percentage: number | string | null;
  escalation_waived: boolean | null;
  parent_contract_id: string | null;
}

const ymdMinus = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const LATEST_COLUMNS = "lead_id, as_of, payment, friction, engagement, profitability, confidence, overall, tier, status, reason, trend_vs_90d, method, story, settings_version, computed_at";
const PREVIOUS_COLUMNS = "lead_id, as_of, payment, friction, engagement, profitability, overall, tier";

type ScoreWithLead = StoredScoreRow & { lead_id: string };

export async function loadPortfolio(supabase: SupabaseClient, today: string): Promise<PortfolioRow[]> {
  const latestFrom = ymdMinus(today, 3);
  const target = ymdMinus(today, 90);

  const [latestRows, previousRows] = await Promise.all([
    fetchAllPages<ScoreWithLead>("latest scores", (from, to) =>
      supabase.from("customer_value_scores").select(LATEST_COLUMNS).gte("as_of", latestFrom).order("lead_id").order("as_of").range(from, to).returns<ScoreWithLead[]>()
    ),
    fetchAllPages<ScoreWithLead>("earlier scores", (from, to) =>
      supabase
        .from("customer_value_scores")
        .select(PREVIOUS_COLUMNS)
        .gte("as_of", ymdMinus(target, PREVIOUS_WINDOW_DAYS))
        .lte("as_of", ymdMinus(target, -PREVIOUS_WINDOW_DAYS))
        .order("lead_id")
        .order("as_of")
        .range(from, to)
        .returns<ScoreWithLead[]>()
    ),
  ]);

  // The newest score per customer, and the one closest to 90 days ago.
  const latest = new Map<string, ScoreWithLead>();
  for (const r of latestRows) if (!latest.has(r.lead_id) || r.as_of > (latest.get(r.lead_id) as ScoreWithLead).as_of) latest.set(r.lead_id, r);
  const previous = new Map<string, ScoreWithLead>();
  for (const r of previousRows) {
    const cur = previous.get(r.lead_id);
    if (!cur || Math.abs(daysBetween(target, r.as_of)) < Math.abs(daysBetween(target, cur.as_of))) previous.set(r.lead_id, r);
  }

  const leadIds = [...latest.keys()];
  if (leadIds.length === 0) return [];

  const [leads, contracts, marginRows, locations] = await Promise.all([
    fetchInChunks<{ id: string; first_name: string | null; last_name: string | null; company: string | null }>("leads", leadIds, (batch, from, to) =>
      supabase.from("leads").select("id, first_name, last_name, company").in("id", batch).order("id").range(from, to)
    ),
    fetchInChunks<ContractRow>("contracts", leadIds, (batch, from, to) =>
      supabase.from("contracts").select("id, lead_id, location_id, status, seats, start_date, activated_at, end_date, escalation_percentage, escalation_waived, parent_contract_id").in("lead_id", batch).order("id").range(from, to)
    ),
    fetchInChunks<ShadowRow & { lead_id: string }>("margin", leadIds, (batch, from, to) =>
      supabase.from("customer_value_margin").select("lead_id, month, revenue, variable_cost, margin_after_variable, confidence").in("lead_id", batch).gte("month", `${ymdMinus(today, 130).slice(0, 7)}-01`).order("lead_id").order("month").range(from, to)
    ),
    supabase.from("locations").select("id, name"),
  ]);
  if (locations.error) throw new Error(locations.error.message);
  const centerName = new Map((locations.data ?? []).map((l) => [l.id as string, l.name as string]));

  const contractsByLead = new Map<string, ContractRow[]>();
  for (const c of contracts) contractsByLead.set(c.lead_id, [...(contractsByLead.get(c.lead_id) ?? []), c]);
  const marginByLead = new Map<string, ShadowRow[]>();
  for (const m of marginRows) marginByLead.set(m.lead_id, [...(marginByLead.get(m.lead_id) ?? []), { month: m.month, revenue: Number(m.revenue), variable_cost: Number(m.variable_cost), margin_after_variable: Number(m.margin_after_variable), confidence: num(m.confidence) }]);
  const nameOf = new Map(leads.map((l) => [l.id, l.company || `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || "Customer"]));

  return leadIds.map((leadId): PortfolioRow => {
    const score = latest.get(leadId) as ScoreWithLead;
    const earlier = previous.get(leadId) ?? null;
    const mine = contractsByLead.get(leadId) ?? [];
    const centerId = chooseServiceCenter(mine);
    const live = mine.filter((c) => LIVE.includes(c.status ?? "") && c.location_id === centerId);
    const ends = live.map((c) => c.end_date).sort();
    const daysToRenewal = ends.length > 0 ? daysBetween(today, ends[0]) : null;

    // A past renewal where the customer got the escalation reduced or dropped.
    const byId = new Map(mine.map((c) => [c.id, c]));
    const pushedBack = mine.some((c) => {
      const parent = c.parent_contract_id ? byId.get(c.parent_contract_id) : undefined;
      if (!parent || !c.activated_at) return false;
      const outcome = classifyEscalation(num(parent.escalation_percentage), num(c.escalation_percentage), Boolean(c.escalation_waived));
      return outcome === "reduced" || outcome === "avoided";
    });

    const shadow = summariseShadow((marginByLead.get(leadId) ?? []).slice(-3));
    const insights = buildInsights({
      latest: score,
      previous: earlier as StoredScoreRow | null,
      marginPerMonth: shadow ? shadow.marginPerMonth : null,
      daysToRenewal,
      pushedBackOnEscalation: pushedBack,
    });

    return {
      leadId,
      name: nameOf.get(leadId) ?? "Customer",
      centerId,
      centerName: centerId ? (centerName.get(centerId) ?? null) : null,
      tier: score.tier as PortfolioTier | null,
      overall: num(score.overall),
      trend: score.trend_vs_90d,
      payment: num(score.payment),
      friction: num(score.friction),
      engagement: num(score.engagement),
      profitability: num(score.profitability),
      previousOverall: earlier ? num(earlier.overall) : null,
      previousTier: (earlier?.tier as PortfolioTier | null | undefined) ?? null,
      change90: change90(num(score.overall), earlier ? num(earlier.overall) : null),
      marginPerMonth: shadow ? shadow.marginPerMonth : null,
      marginPct: shadow ? shadow.marginPct : null,
      daysToRenewal,
      hasLiveContract: mine.some((c) => LIVE.includes(c.status ?? "")),
      insights: insights.map(({ key, tone, text }) => ({ key, tone, text })),
    };
  });
}

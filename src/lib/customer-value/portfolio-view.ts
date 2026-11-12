/**
 * Customer Value — the portfolio list
 * (docs/plans/customer-value-phase6-portfolio.md, section 2.1).
 *
 * Pure shaping of stored figures into one row per customer, with the change over
 * the last 90 days, and the sorts and filters the page offers.
 */

import type { Insight } from "@/lib/customer-value/insights";

export type PortfolioTier = "A" | "B" | "C" | "D";

export interface PortfolioRow {
  leadId: string;
  name: string;
  centerId: string | null;
  centerName: string | null;
  tier: PortfolioTier | null;
  overall: number | null;
  trend: "up" | "down" | "flat" | null;
  payment: number | null;
  friction: number | null;
  engagement: number | null;
  profitability: number | null;
  /** Overall score about 90 days earlier; null when none was stored. */
  previousOverall: number | null;
  previousTier: PortfolioTier | null;
  /** Overall now minus overall then: negative is a drop. Null unless both are known. */
  change90: number | null;
  /** Average margin after variable costs a month, and as a share of revenue. */
  marginPerMonth: number | null;
  marginPct: number | null;
  /** Days until the live contract ends; null with no live contract. */
  daysToRenewal: number | null;
  hasLiveContract: boolean;
  insights: Array<Pick<Insight, "key" | "tone" | "text">>;
}

export type PortfolioSort = "biggest_drop" | "renewal_soonest" | "lowest_tier" | "lowest_margin";

export const SORT_LABELS: Record<PortfolioSort, string> = {
  biggest_drop: "Biggest drop",
  renewal_soonest: "Renewal soonest",
  lowest_tier: "Lowest tier",
  lowest_margin: "Lowest margin",
};

export interface PortfolioFilter {
  centerId?: string | null;
  tiers?: PortfolioTier[];
  /** Keep only customers whose live contract ends within this many days (and has not ended). */
  renewingWithinDays?: number | null;
  /** Past customers are left out unless this is set. */
  includePast?: boolean;
}

export const DEFAULT_RENEWING_WITHIN_DAYS = 90;

export function change90(now: number | null, then: number | null): number | null {
  return now === null || then === null ? null : Math.round((now - then) * 10) / 10;
}

const TIER_RANK: Record<PortfolioTier, number> = { D: 0, C: 1, B: 2, A: 3 };

/** Rows that lack the sort's figure always go last, so a sort never opens with blanks. */
function by(value: (r: PortfolioRow) => number | null, direction: 1 | -1, tie: (a: PortfolioRow, b: PortfolioRow) => number) {
  return (a: PortfolioRow, b: PortfolioRow): number => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return tie(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * direction || tie(a, b);
  };
}

const byName = (a: PortfolioRow, b: PortfolioRow) => a.name.localeCompare(b.name);

export function sortPortfolio(rows: PortfolioRow[], sort: PortfolioSort): PortfolioRow[] {
  const compare = {
    biggest_drop: by((r) => r.change90, 1, byName),
    renewal_soonest: by((r) => (r.daysToRenewal !== null && r.daysToRenewal >= 0 ? r.daysToRenewal : null), 1, byName),
    lowest_tier: by((r) => (r.tier ? TIER_RANK[r.tier] * 1000 + (r.overall ?? 0) : null), 1, byName),
    lowest_margin: by((r) => r.marginPerMonth, 1, byName),
  }[sort];
  return [...rows].sort(compare);
}

export function filterPortfolio(rows: PortfolioRow[], f: PortfolioFilter): PortfolioRow[] {
  return rows.filter((r) => {
    if (!f.includePast && !r.hasLiveContract) return false;
    if (f.centerId && r.centerId !== f.centerId) return false;
    if (f.tiers && f.tiers.length > 0 && (!r.tier || !f.tiers.includes(r.tier))) return false;
    if (f.renewingWithinDays != null && !(r.daysToRenewal !== null && r.daysToRenewal >= 0 && r.daysToRenewal <= f.renewingWithinDays)) return false;
    return true;
  });
}

export interface PortfolioSummary {
  customers: number;
  byTier: Record<PortfolioTier | "none", number>;
  dropped: number;
  renewingSoon: number;
  atRisk: number;
}

/** Headline counts over the rows shown. */
export function summarisePortfolio(rows: PortfolioRow[], renewingWithinDays = DEFAULT_RENEWING_WITHIN_DAYS): PortfolioSummary {
  const byTier: PortfolioSummary["byTier"] = { A: 0, B: 0, C: 0, D: 0, none: 0 };
  for (const r of rows) byTier[r.tier ?? "none"]++;
  return {
    customers: rows.length,
    byTier,
    dropped: rows.filter((r) => r.previousTier && r.tier && TIER_RANK[r.tier] < TIER_RANK[r.previousTier]).length,
    renewingSoon: rows.filter((r) => r.daysToRenewal !== null && r.daysToRenewal >= 0 && r.daysToRenewal <= renewingWithinDays).length,
    atRisk: rows.filter((r) => r.insights.some((i) => i.tone === "risk")).length,
  };
}

/**
 * Customer Value — cross-pillar insights
 * (docs/plans/customer-value-phase6-portfolio.md, section 2.3).
 *
 * Rule-written observations that put the pillars side by side, the renewal date
 * and the shadow margin, which no single score says. No AI text: each rule is a
 * threshold on stored figures and names the metrics it rests on, so every
 * sentence can be traced. Pure; the caller loads the stored rows.
 */

import { formatCurrency } from "@/lib/utils";
import { PILLAR_LABELS, type StoredScoreRow } from "@/lib/customer-value/summary-view";
import type { PillarKey } from "@/lib/customer-value/scoring-settings";

/** Starting thresholds. First-cut: meant to be tuned once there are real examples. */
export const INSIGHT_THRESHOLDS = {
  renewingWithinDays: 90,
  /** A Payment score at or below this is "pays late". */
  latePayment: 50,
  /** A Friction score at or above this is "little friction"; at or below `highFriction` is "a lot". */
  calmFriction: 70,
  highFriction: 45,
  /** A Profitability score at or above this is "strong revenue side". */
  strongRevenue: 65,
  /** Seat change over the window, percent, at or below which seats are "shrinking". */
  shrinkingSeatsPct: -10,
  /** Rent per seat as a share of the center's median, at or below which there is "room to raise". */
  rentBelowCenter: 0.9,
  /** A Payment score at or above this is "pays on time". */
  goodPayer: 75,
} as const;

export type InsightKey =
  | "late_not_service"
  | "valuable_but_friction"
  | "negative_margin"
  | "shrinking_and_renewing"
  | "pushed_back_and_renewing"
  | "room_to_raise"
  | "tier_dropped"
  | "healthy_and_renewing";

export type InsightTone = "risk" | "watch" | "good";

export interface Insight {
  key: InsightKey;
  tone: InsightTone;
  text: string;
  /** The metrics or figures the sentence rests on, for the audit trail. */
  basis: string[];
}

export interface InsightInput {
  latest: StoredScoreRow | null;
  /** The score about 90 days earlier, when one exists. */
  previous: StoredScoreRow | null;
  /** Average margin after variable costs a month over recent months; null when none is stored. */
  marginPerMonth: number | null;
  /** Days until the live contract ends; null when there is none. Negative once past. */
  daysToRenewal: number | null;
  /** A past renewal where escalation was reduced or avoided. */
  pushedBackOnEscalation: boolean;
}

const TIER_ORDER: Record<string, number> = { A: 3, B: 2, C: 1, D: 0 };
const TONE_ORDER: Record<InsightTone, number> = { risk: 0, watch: 1, good: 2 };
const MAX_INSIGHTS = 5;
const PILLARS: PillarKey[] = ["payment", "friction", "engagement", "profitability"];

function metricValue(row: StoredScoreRow, pillar: PillarKey, key: string): number | null {
  const m = row.method?.pillars?.[pillar]?.metrics.find((x) => x.key === key);
  return m && m.status === "ok" ? m.value : null;
}

/** The pillar that fell furthest between two scores, with how far; null when none fell or none can be compared. */
export function biggestPillarDrop(latest: StoredScoreRow, previous: StoredScoreRow): { pillar: PillarKey; points: number } | null {
  let worst: { pillar: PillarKey; points: number } | null = null;
  for (const p of PILLARS) {
    const now = latest[p];
    const before = previous[p];
    if (now === null || before === null) continue;
    const delta = now - before;
    if (delta < 0 && (worst === null || delta < worst.points)) worst = { pillar: p, points: delta };
  }
  return worst;
}

function renewsSoon(days: number | null): days is number {
  return days !== null && days >= 0 && days <= INSIGHT_THRESHOLDS.renewingWithinDays;
}

export function buildInsights(input: InsightInput): Insight[] {
  const { latest, previous } = input;
  const T = INSIGHT_THRESHOLDS;
  const out: Insight[] = [];
  if (!latest) return out;

  const payment = latest.payment;
  const friction = latest.friction;
  const profitability = latest.profitability;
  const days = input.daysToRenewal;

  if (payment !== null && friction !== null && payment <= T.latePayment && friction >= T.calmFriction) {
    out.push({
      key: "late_not_service",
      tone: "watch",
      text: "Pays late but causes little friction: a collections problem, not a service one.",
      basis: ["payment", "friction"],
    });
  }

  if (profitability !== null && friction !== null && profitability >= T.strongRevenue && friction <= T.highFriction) {
    out.push({
      key: "valuable_but_friction",
      tone: "risk",
      text: "A strong customer on the revenue side, but service friction is high: worth fixing before the renewal.",
      basis: ["profitability", "friction"],
    });
  }

  if (input.marginPerMonth !== null && input.marginPerMonth < 0) {
    out.push({
      key: "negative_margin",
      tone: "risk",
      text: `Costs more to serve than it pays: margin after variable costs is about ${formatCurrency(Math.abs(input.marginPerMonth))} a month below zero (an estimate that rests on the cost rates entered).`,
      basis: ["margin_after_variable"],
    });
  }

  const seatTrend = metricValue(latest, "engagement", "seat_trend_pct");
  if (seatTrend !== null && seatTrend <= T.shrinkingSeatsPct && renewsSoon(days)) {
    out.push({
      key: "shrinking_and_renewing",
      tone: "risk",
      text: `Seats are down ${Math.abs(Math.round(seatTrend))}% and the contract ends in ${days} day${days === 1 ? "" : "s"}: at risk of leaving or shrinking again.`,
      basis: ["seat_trend_pct", "days_to_renewal"],
    });
  }

  if (input.pushedBackOnEscalation && renewsSoon(days)) {
    out.push({
      key: "pushed_back_and_renewing",
      tone: "watch",
      text: `Pushed back on escalation at an earlier renewal and the contract ends in ${days} day${days === 1 ? "" : "s"}: expect the same conversation.`,
      basis: ["escalation_outcomes", "days_to_renewal"],
    });
  }

  const rentVsCenter = metricValue(latest, "profitability", "rent_vs_center");
  if (rentVsCenter !== null && rentVsCenter <= T.rentBelowCenter && payment !== null && payment >= T.goodPayer) {
    out.push({
      key: "room_to_raise",
      tone: "good",
      text: `Pays on time and rent per seat is ${Math.round(rentVsCenter * 100)}% of the center's: there is room to raise it at renewal.`,
      basis: ["rent_vs_center", "payment"],
    });
  }

  if (previous && latest.tier && previous.tier && TIER_ORDER[latest.tier] < TIER_ORDER[previous.tier]) {
    const drop = biggestPillarDrop(latest, previous);
    out.push({
      key: "tier_dropped",
      tone: "risk",
      text: `Dropped from ${previous.tier} to ${latest.tier} in the last 90 days${drop ? `; the biggest move was ${PILLAR_LABELS[drop.pillar].toLowerCase()} (${Math.round(drop.points)} points)` : ""}.`,
      basis: ["tier", ...(drop ? [drop.pillar] : [])],
    });
  }

  if (latest.tier === "A" && latest.trend_vs_90d !== "down" && renewsSoon(days)) {
    out.push({
      key: "healthy_and_renewing",
      tone: "good",
      text: `Healthy all round and the contract ends in ${days} day${days === 1 ? "" : "s"}: consider renewing early.`,
      basis: ["tier", "days_to_renewal"],
    });
  }

  return out.map((insight, i) => ({ insight, i })).sort((a, b) => TONE_ORDER[a.insight.tone] - TONE_ORDER[b.insight.tone] || a.i - b.i).map((x) => x.insight).slice(0, MAX_INSIGHTS);
}

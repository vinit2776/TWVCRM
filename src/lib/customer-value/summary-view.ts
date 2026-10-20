/**
 * Customer Value — shaping stored scores for the Summary sub-tab.
 *
 * Pure helpers: which score rows make the 12-month line, how a pillar is
 * explained in one line, how its confidence is labelled, and whether the stored
 * score is stale. Reads the shapes written by `scoring-run.ts` (`toScoreRecord`).
 */

export type PillarKey = "payment" | "friction" | "engagement" | "profitability";
export const SUMMARY_PILLARS: PillarKey[] = ["payment", "friction", "engagement", "profitability"];

export const PILLAR_LABELS: Record<PillarKey, string> = {
  payment: "Payment",
  friction: "Friction",
  engagement: "Engagement",
  profitability: "Revenue health",
};

export const PILLAR_HELP: Record<PillarKey, string> = {
  payment: "How promptly they pay: days late, on-time share, overdue balance, reminders needed.",
  friction: "How much trouble they cause or run into: tickets, SLA breaches, repeat issues, ratings, billing queries. Higher is calmer.",
  engagement: "How much they use what they pay for: seats used, bookings, seat trend, renewals.",
  profitability: "Revenue side only for now: concessions given, rent against the center, escalation outcomes. Real margin needs cost data.",
};

/** Revenue health's help once margin after variable costs is counted in it. */
export const PROFITABILITY_HELP_WITH_MARGIN =
  "Concessions given, rent against the center, escalation outcomes, and margin after variable costs where enough of the cost is measured.";

/** Whether this stored pillar counted a margin (margin scoring on and a usable margin found). */
export function marginCounted(method: StoredPillarMethod | undefined): boolean {
  return method?.metrics.some((m) => m.key === "margin_pct" && m.status === "ok") ?? false;
}

export const METRIC_LABELS: Record<string, string> = {
  avg_days_late: "days late",
  on_time_share: "on-time share",
  overdue_ratio: "overdue balance",
  reminders_per_invoice: "reminders needed",
  tickets_per_seat_quarter: "tickets per seat",
  sla_breached_share: "SLA breaches",
  repeat_share: "repeat issues",
  satisfaction_avg: "ratings",
  billing_queries_per_quarter: "billing queries",
  seats_used_ratio: "seats used",
  bookings_per_seat_month: "bookings",
  seat_trend_pct: "seat trend",
  renewal_behaviour: "renewals",
  concessions_pct: "concessions",
  rent_vs_center: "rent against the center",
  escalation_outcomes: "escalation outcomes",
  margin_pct: "margin after variable costs",
};

export interface StoredMetric {
  key: string;
  status: "ok" | "missing" | "na";
  method: string | null;
  cohort_size: number;
  value: number | null;
  score: number | null;
}

export interface StoredPillarMethod {
  notes: string[];
  months_used: number;
  metrics: StoredMetric[];
}

export interface StoredScoreRow {
  as_of: string;
  payment: number | null;
  friction: number | null;
  engagement: number | null;
  profitability: number | null;
  confidence: Partial<Record<PillarKey, number>>;
  overall: number | null;
  tier: "A" | "B" | "C" | "D" | null;
  status: "graded" | "not_enough_data";
  reason: string | null;
  trend_vs_90d: "up" | "down" | "flat" | null;
  method: {
    pillars?: Partial<Record<PillarKey, StoredPillarMethod>>;
    confident_pillars?: PillarKey[];
    tier_cap?: { pillar: PillarKey; maxTier: string } | null;
    previous_overall?: number | null;
  } | null;
  story: {
    sentences?: Array<{ metric: string; text: string; evidence: string[] }>;
    action?: { code: string; text: string };
  } | null;
  settings_version: string | null;
  computed_at: string;
}

export interface SeriesPoint {
  asOf: string;
  overall: number;
  tier: string | null;
}

/**
 * One point per month for the line: the last stored score of each month that
 * could be graded, oldest first, limited to the last `months` months up to and
 * including `today`'s month. Ungraded rows have no overall and are skipped.
 */
export function monthlySeries(rows: StoredScoreRow[], today: string, months = 12): SeriesPoint[] {
  const todayIndex = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  const lastPerMonth = new Map<string, StoredScoreRow>();
  for (const r of [...rows].sort((a, b) => (a.as_of < b.as_of ? -1 : 1))) {
    if (r.overall === null) continue;
    const monthIndex = Number(r.as_of.slice(0, 4)) * 12 + Number(r.as_of.slice(5, 7)) - 1;
    if (monthIndex > todayIndex || todayIndex - monthIndex >= months) continue;
    lastPerMonth.set(r.as_of.slice(0, 7), r);
  }
  return [...lastPerMonth.values()].map((r) => ({ asOf: r.as_of, overall: r.overall as number, tier: r.tier }));
}

export type ConfidenceChip = { label: string; tone: "good" | "warn" | "bad" };

/** How much to trust a pillar, in words. Revenue health is partial unless a margin was counted in it. */
export function confidenceChip(
  pillar: PillarKey,
  score: number | null,
  confidence: number | undefined,
  withMargin = false
): ConfidenceChip {
  if (score === null) return { label: "No data", tone: "bad" };
  if (confidence !== undefined && confidence < 0.5) return { label: "Low confidence", tone: "bad" };
  if (pillar === "profitability" && !withMargin) return { label: "Partial", tone: "warn" };
  if (confidence !== undefined && confidence < 0.9) return { label: "Some gaps", tone: "warn" };
  return { label: "Full data", tone: "good" };
}

/** One line on what drives a pillar: its weakest measured metric, or its caveat when nothing was measured. */
export function pillarHeadline(method: StoredPillarMethod | undefined, score: number | null): string {
  if (!method) return score === null ? "Not enough data yet" : "";
  const scored = method.metrics.filter((m) => m.status === "ok" && m.score !== null);
  if (scored.length === 0) return method.notes[0] ?? "Not enough data yet";
  const weakest = scored.reduce((a, b) => ((a.score as number) <= (b.score as number) ? a : b));
  const label = METRIC_LABELS[weakest.key] ?? weakest.key;
  if ((weakest.score as number) >= 90) return "Nothing weighing this down";
  return `Weakest: ${label} (${Math.round(weakest.score as number)})`;
}

/** Hours since the score was computed; null if the date is unreadable. */
export function hoursSince(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (now.getTime() - t) / 3_600_000;
}

/** Plain wording for how long ago the score was computed. */
export function computedAgo(iso: string, now: Date): string {
  const h = hoursSince(iso, now);
  if (h === null) return "Computed at an unknown time";
  if (h < 1) return "Computed just now";
  if (h < 24) return `Computed ${Math.floor(h)} hour${Math.floor(h) === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `Computed ${d} day${d === 1 ? "" : "s"} ago`;
}

/** Older than a day and a half means a nightly run was missed. */
export function isStale(iso: string, now: Date): boolean {
  const h = hoursSince(iso, now);
  return h !== null && h > 36;
}

export const TIER_STYLES: Record<string, string> = {
  A: "bg-green-100 text-green-800",
  B: "bg-blue-100 text-blue-800",
  C: "bg-amber-100 text-amber-800",
  D: "bg-red-100 text-red-800",
};

export const TREND_TEXT: Record<"up" | "down" | "flat", string> = {
  up: "Rising",
  down: "Falling",
  flat: "Steady",
};

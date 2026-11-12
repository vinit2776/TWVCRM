/**
 * The decision a person records on a Virtual Office case whose term has
 * ended without payment: the client has paid, give them more time, or go
 * ahead with discontinuation. Each needs a reason, kept on the case and in
 * the audit trail.
 *
 * Pure, so the limits are unit testable and the route and panel agree.
 */

export const LAPSE_DECISIONS = ["paid", "more_time", "discontinue"] as const;
export type LapseDecision = (typeof LAPSE_DECISIONS)[number];

export const LAPSE_DECISION_LABELS: Record<LapseDecision, string> = {
  paid: "Client has paid or renewed",
  more_time: "Give more time",
  discontinue: "Go ahead with discontinuation",
};

export const LAPSE_DECISION_ROLES = ["admin", "manager"];
export const LAPSE_REASON_MIN_LENGTH = 10;
/** One extension can push the grace end at most this far past today. */
export const MAX_GRACE_EXTENSION_DAYS = 15;
/** Extensions allowed per term (each term is its own case). */
export const MAX_GRACE_EXTENSIONS = 2;

/** Statuses on which a decision can be recorded, once the end date has passed. */
export const LAPSE_DECIDABLE_STATUSES = ["active", "renewal_due", "grace_period", "lapsed"];

export interface LapseDecisionRecord {
  decision: LapseDecision;
  reason: string;
  /** more_time only: the last day the case stays in grace. */
  until?: string;
  by: string;
  by_name: string | null;
  at: string;
}

/** The decisions recorded on a case, oldest first. Kept in cases.metadata.lapse_decisions. */
export function lapseDecisions(metadata: unknown): LapseDecisionRecord[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const list = (metadata as Record<string, unknown>).lapse_decisions;
  return Array.isArray(list) ? (list as LapseDecisionRecord[]) : [];
}

export function latestLapseDecision(metadata: unknown): LapseDecisionRecord | null {
  const list = lapseDecisions(metadata);
  return list.length ? list[list.length - 1] : null;
}

export function extensionsUsed(metadata: unknown): number {
  return lapseDecisions(metadata).filter((d) => d.decision === "more_time").length;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date.slice(0, 10) + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

/** The latest date "Give more time" accepts today. */
export function latestGraceDate(today: string): string {
  return addDays(today, MAX_GRACE_EXTENSION_DAYS);
}

/** Why a "Give more time" to `until` can't be recorded, or null if it can. */
export function checkMoreTime(params: { today: string; until: string; used: number }): string | null {
  const { today, until, used } = params;
  if (used >= MAX_GRACE_EXTENSIONS) {
    return `This term has already been given more time ${MAX_GRACE_EXTENSIONS} times. Record paid or discontinue instead.`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return "Choose the new grace end date.";
  if (until <= today) return "The new grace end date must be after today.";
  if (until > latestGraceDate(today)) {
    return `More time can be at most ${MAX_GRACE_EXTENSION_DAYS} days from today.`;
  }
  return null;
}

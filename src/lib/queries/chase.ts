/**
 * When to chase an unanswered query, and how hard.
 *
 * Pure so the rules are unit-testable — a chase loop that misfires is worse
 * than no chase loop, because people learn to ignore it and then the real
 * ones don't land either.
 *
 * Two independent triggers, one decision:
 *
 *   escalate — the thread has gone quiet for 48h. This is the original
 *              behaviour from #433 and keeps its own `escalated_at` stamp, so
 *              a thread escalates at most once per stretch of silence (any
 *              new message clears it).
 *
 *   nudge    — the thread is past the needed_by date its asker set. Capped at
 *              one per day via `last_nudged_at`, because a reminder that
 *              arrives every six hours is just noise wearing a deadline.
 *
 * Escalation wins when both apply: it reaches for the louder channel, and
 * sending two chases about the same thread in one run would be silly.
 *
 * Only queries that were *given* a needed_by are ever nudged. That's what
 * keeps the date meaningful — see NeededByPicker.
 */

export const ESCALATE_AFTER_HOURS = 48;
// Deliberately under 24h. The digest cron runs once a day and its start time
// drifts by seconds; a 24h cooldown would see "23h59m since the last nudge" on
// the next run and silently skip every other day.
export const NUDGE_COOLDOWN_HOURS = 20;
/** Past this much overdue, the chase also reaches admin + manager. */
export const ESCALATE_TO_MANAGEMENT_AFTER_DAYS = 3;

export type ChaseKind = "none" | "nudge" | "escalate";

export interface ChaseInput {
  status: "open" | "resolved";
  /** YYYY-MM-DD, or null when the asker set no date. */
  needed_by: string | null;
  escalated_at: string | null;
  last_nudged_at: string | null;
  /** Timestamp of the most recent message, or null for an empty thread. */
  last_message_at: string | null;
  /** Injected so the decision is deterministic in tests. */
  now: Date;
}

export interface ChaseDecision {
  kind: ChaseKind;
  /** Whole days past needed_by; 0 when not overdue or undated. */
  overdueDays: number;
  /** Widen the recipients to admin + manager. */
  involveManagement: boolean;
}

function hoursBetween(from: string, to: Date): number {
  return (to.getTime() - new Date(from).getTime()) / 3_600_000;
}

/** Whole days from a YYYY-MM-DD date to `now`, at day granularity. */
export function daysOverdue(neededBy: string, now: Date): number {
  const due = Date.parse(`${neededBy}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.floor((today - due) / 86_400_000);
}

export function decideChase(input: ChaseInput): ChaseDecision {
  const none: ChaseDecision = { kind: "none", overdueDays: 0, involveManagement: false };
  if (input.status !== "open") return none;

  const overdue = input.needed_by ? daysOverdue(input.needed_by, input.now) : 0;
  const involveManagement = overdue >= ESCALATE_TO_MANAGEMENT_AFTER_DAYS;

  // 48h of silence, not already escalated for this stretch.
  const silentLongEnough =
    !!input.last_message_at && hoursBetween(input.last_message_at, input.now) >= ESCALATE_AFTER_HOURS;
  if (silentLongEnough && !input.escalated_at) {
    return { kind: "escalate", overdueDays: Math.max(overdue, 0), involveManagement };
  }

  // Past its due date, and not chased in the last day.
  const nudgeCooledDown =
    !input.last_nudged_at || hoursBetween(input.last_nudged_at, input.now) >= NUDGE_COOLDOWN_HOURS;
  if (overdue > 0 && nudgeCooledDown) {
    return { kind: "nudge", overdueDays: overdue, involveManagement };
  }

  return { ...none, overdueDays: Math.max(overdue, 0), involveManagement };
}

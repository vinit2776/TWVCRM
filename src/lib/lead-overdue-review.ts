import { istDayKey } from "@/lib/lead-days";

// The overdue review: a lead whose next step is more than a fortnight past due is no longer "late",
// it is forgotten, and it makes the real overdue number meaningless. Someone looks at these leads in
// one go and decides for each: push the date out, set a new date, or close it as no response.
// One definition, so Home, the Follow-ups tab and the review's own actions can never disagree.

export const OVERDUE_REVIEW_DAYS = 14;
/** What "Snooze" does: move the next step this many days from today. */
export const SNOOZE_DAYS = 7;
/** Most leads one action may change, so a slip of the hand cannot rewrite the whole pipeline. */
export const REVIEW_BATCH_MAX = 100;

export const REVIEW_ACTIONS = ["snooze", "new_date", "close_no_response"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REVIEW_ACTION_LABELS: Record<ReviewAction, string> = {
  snooze: `Snooze ${SNOOZE_DAYS} days`,
  new_date: "Set a new date",
  close_no_response: "Close as no response",
};

/** `off` hides the review, `dry_run` shows it and previews each action without changing anything, `live` applies them. */
export const REVIEW_MODES = ["off", "dry_run", "live"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** An unknown or missing setting reads as the safe one: preview only. */
export function parseReviewMode(value: string | null | undefined): ReviewMode {
  return (REVIEW_MODES as readonly string[]).includes(value ?? "") ? (value as ReviewMode) : "dry_run";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole IST days a follow-up is past due; 0 or less when it is due today or later. */
export function daysOverdue(dueAt: string, now: Date = new Date()): number {
  return Math.round((Date.parse(istDayKey(now)) - Date.parse(istDayKey(dueAt))) / DAY_MS);
}

export interface PileRow {
  leadId: string;
  dueAt: string;
  daysOverdue: number;
}

/**
 * The leads in the pile, most overdue first. `nextDue` is each open lead's soonest pending follow-up,
 * the same figure the Follow-ups tab groups by, so a lead is in the pile exactly when it is in that
 * tab's Overdue pill and the date is at least OVERDUE_REVIEW_DAYS old.
 */
export function reviewPile(nextDue: Map<string, string>, now: Date = new Date()): PileRow[] {
  const rows: PileRow[] = [];
  for (const [leadId, dueAt] of nextDue) {
    const days = daysOverdue(dueAt, now);
    if (days >= OVERDUE_REVIEW_DAYS) rows.push({ leadId, dueAt, daysOverdue: days });
  }
  return rows.sort((a, b) => b.daysOverdue - a.daysOverdue || a.leadId.localeCompare(b.leadId));
}

/** Admins and managers may act on any lead in the pile; everyone else only on their own. */
export function canActOnPileLead(role: string | null | undefined, meId: string, ownerId: string | null): boolean {
  if (role === "admin" || role === "manager") return true;
  return ownerId !== null && ownerId === meId;
}

/** Where "Snooze" puts the next step: the same time of day (IST wall clock is kept by adding whole days). */
export function snoozedTo(now: Date = new Date(), days: number = SNOOZE_DAYS): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

/** A new date for a stale next step must be in the future; returns an error to show, or null when it is fine. */
export function newDateProblem(dateIso: string | null | undefined, now: Date = new Date()): string | null {
  if (!dateIso) return "Pick the new date";
  const t = Date.parse(dateIso);
  if (Number.isNaN(t)) return "That date is not valid";
  if (istDayKey(new Date(t)) <= istDayKey(now)) return "Pick a date after today";
  return null;
}

// When a lead has gone quiet. A lead is "stale" once nothing has happened on it for 15 days and
// nothing is scheduled ahead; the system then archives it (nothing is deleted, one tap restores it).
// This is the single definition: the Leads list badge, the activity page and the daily archive job
// all use it, so they can never disagree about which leads are stale.

export const STALE_AFTER_DAYS = 15;
/** The badge starts counting down this many days before the lead goes stale. */
export const STALE_WARNING_DAYS = 3;

/** A lead in these statuses is finished one way or the other: nothing to chase. */
export const STALE_FINISHED_STATUSES = ["won", "lost", "junk"] as const;

/** A tour booked or a proposal out is a conversation in progress, so quiet days don't count. */
export const STALE_IN_PROGRESS_STATUSES = ["tour_scheduled", "proposal_sent", "negotiating"] as const;

/** Never stale: finished, or in the middle of a tour or proposal. */
export const STALE_EXEMPT_STATUSES = [...STALE_FINISHED_STATUSES, ...STALE_IN_PROGRESS_STATUSES] as const;

/** Notes the system writes when a lead changes hands or a follow-up is closed. They are bookkeeping, not contact. */
export const NON_EVENT_SUBJECTS = ["Claimed", "Reassigned", "Follow-up closed"] as const;

export type StaleState =
  | { state: "active" }
  | { state: "warning"; daysLeft: number }
  | { state: "stale"; daysQuiet: number };

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleInput {
  status: string;
  archivedAt?: string | null;
  /** A pinned lead is kept in front of the team on purpose, so it never goes stale. */
  pinnedAt?: string | null;
  /** The latest thing that happened: a call, a note, a re-enquiry, or the lead being created. */
  lastEventAt: string;
  /** A follow-up still to do, due in the future: someone has the next move booked. */
  hasFutureFollowUp: boolean;
  now?: Date;
}

export function leadStaleState(i: StaleInput): StaleState {
  if (i.archivedAt || i.pinnedAt) return { state: "active" };
  if ((STALE_EXEMPT_STATUSES as readonly string[]).includes(i.status)) return { state: "active" };
  if (i.hasFutureFollowUp) return { state: "active" };

  const now = i.now ?? new Date();
  const daysQuiet = Math.floor((now.getTime() - Date.parse(i.lastEventAt)) / DAY_MS);
  if (daysQuiet >= STALE_AFTER_DAYS) return { state: "stale", daysQuiet };
  const daysLeft = STALE_AFTER_DAYS - daysQuiet;
  if (daysLeft <= STALE_WARNING_DAYS) return { state: "warning", daysLeft };
  return { state: "active" };
}

/** The latest of a set of instants (ISO strings), ignoring missing ones. */
export function latestInstant(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v && (best === null || Date.parse(v) > Date.parse(best))) best = v;
  }
  return best;
}

/**
 * Due dates for the "get the customer in" steps. Derived, not stored: a step is
 * due a fixed number of days after the contract was activated, so there is no
 * schema to migrate and nothing to keep in sync.
 */

/** Steps that get a due date. "activated" itself is excluded: it is the trigger. */
export const ONBOARDING_DUE_KEYS: ReadonlySet<string> = new Set([
  "seats_assigned",
  "members_added",
  "wifi_vouchers",
  "door_access",
  "welcome_done",
]);

export const ONBOARDING_DUE_DAYS = 2;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Calendar date (YYYY-MM-DD) of an instant as seen in IST. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Due date: activation day (IST) plus ONBOARDING_DUE_DAYS. */
export function dueDateFor(activatedAt: string): string {
  const day = istDate(new Date(activatedAt));
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + ONBOARDING_DUE_DAYS * DAY_MS).toISOString().slice(0, 10);
}

export type DueState = "late" | "today" | "upcoming";

export interface DueInfo {
  state: DueState;
  /** Whole days past due when late, else 0. */
  daysLate: number;
}

export function dueInfo(due: string, now: Date = new Date()): DueInfo {
  const today = istDate(now);
  if (due < today) {
    const daysLate = Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${due}T00:00:00Z`).getTime()) / DAY_MS);
    return { state: "late", daysLate };
  }
  return { state: due === today ? "today" : "upcoming", daysLate: 0 };
}

/** "Due today", "Due 17 Oct", "1 day late". */
export function dueLabel(due: string, now: Date = new Date()): string {
  const info = dueInfo(due, now);
  if (info.state === "late") return info.daysLate === 1 ? "1 day late" : `${info.daysLate} days late`;
  if (info.state === "today") return "Due today";
  return `Due ${new Date(`${due}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" })}`;
}

/**
 * Which tab of the Renewals desk a Virtual Office case belongs on.
 *
 * Pure, so the bucketing is unit testable and the page and API agree.
 *
 * Staged by date as well as status on purpose: the renewal cron that moves
 * cases to renewal_due / grace_period / lapsed is not scheduled, so a case can
 * sit at "active" weeks after its end date. Reading only cases.status would
 * show those as comfortably live. The case's own status still wins where it
 * is further along (a case marked lapsed stays lapsed).
 */

export const RENEWAL_DESK_WINDOW_DAYS = 60;
/** Mirrors the cron's hardcoded 7-day grace (src/app/api/cron/vo-renewal). */
export const RENEWAL_GRACE_DAYS = 7;

export const RENEWAL_DESK_TABS = ["coming", "due", "grace", "lapsed"] as const;
export type RenewalDeskTab = (typeof RENEWAL_DESK_TABS)[number];

export const RENEWAL_DESK_TAB_LABELS: Record<RenewalDeskTab, string> = {
  coming: `Coming up (${RENEWAL_DESK_WINDOW_DAYS} days)`,
  due: "Renewal due",
  grace: "In grace",
  lapsed: "Lapsed",
};

export const RENEWAL_DESK_TAB_HINTS: Record<RenewalDeskTab, string> = {
  coming: "Not yet contacted",
  due: "Notice sent, unpaid",
  grace: `Ended, ${RENEWAL_GRACE_DAYS}-day window`,
  lapsed: "Decision needed",
};

/** Statuses a case can have and still be on the desk. */
export const RENEWAL_DESK_STATUSES = ["active", "renewal_due", "grace_period", "lapsed"] as const;

/** Whole days from `today` to `endDate` (both YYYY-MM-DD); negative once past. */
export function daysUntil(endDate: string, today: string): number {
  const a = Date.parse(today.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(endDate.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

export function renewalDeskTab(
  c: { status: string; end_date: string | null },
  today: string,
  hasOpenRenewalBill: boolean,
): RenewalDeskTab | null {
  if (!(RENEWAL_DESK_STATUSES as readonly string[]).includes(c.status)) return null;
  if (c.status === "lapsed") return "lapsed";
  if (!c.end_date) return null;

  const days = daysUntil(c.end_date, today);
  if (days < -RENEWAL_GRACE_DAYS) return "lapsed";
  if (c.status === "grace_period" || days < 0) return "grace";
  if (c.status === "renewal_due" || hasOpenRenewalBill) return "due";
  if (days <= RENEWAL_DESK_WINDOW_DAYS) return "coming";
  return null;
}

/** Short phrase for the date column: "in 12 days", "ended 3 days ago". */
export function relativeEnd(days: number): string {
  if (days === 0) return "ends today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  const ago = -days;
  return `ended ${ago} day${ago === 1 ? "" : "s"} ago`;
}

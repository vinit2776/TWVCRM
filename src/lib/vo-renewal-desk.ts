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

/**
 * Days after the end date a case stays in grace before it lapses. Set by an
 * admin under Settings → Virtual office (app_settings), read by the desk and
 * the renewal cron alike.
 */
export const VO_RENEWAL_GRACE_DAYS_SETTING = "vo_renewal_grace_days";
export const DEFAULT_RENEWAL_GRACE_DAYS = 7;
export const MAX_RENEWAL_GRACE_DAYS = 30;

/** The stored setting as a day count; anything missing or out of range is the default. */
export function parseGraceDays(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_RENEWAL_GRACE_DAYS ? n : DEFAULT_RENEWAL_GRACE_DAYS;
}

export const RENEWAL_DESK_TABS = ["coming", "due", "grace", "lapsed"] as const;
export type RenewalDeskTab = (typeof RENEWAL_DESK_TABS)[number];

export const RENEWAL_DESK_TAB_LABELS: Record<RenewalDeskTab, string> = {
  coming: `Coming up (${RENEWAL_DESK_WINDOW_DAYS} days)`,
  due: "Renewal due",
  grace: "In grace",
  lapsed: "Lapsed",
};

export function renewalDeskTabHint(tab: RenewalDeskTab, graceDays: number): string {
  switch (tab) {
    case "coming":
      return "Not yet contacted";
    case "due":
      return "Notice sent, unpaid";
    case "grace":
      return `Ended, ${graceDays}-day window`;
    case "lapsed":
      return "Decision needed";
  }
}

/** Statuses a case can have and still be on the desk. */
export const RENEWAL_DESK_STATUSES = ["active", "renewal_due", "grace_period", "lapsed"] as const;

/** Whole days from `today` to `endDate` (both YYYY-MM-DD); negative once past. */
export function daysUntil(endDate: string, today: string): number {
  const a = Date.parse(today.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(endDate.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date.slice(0, 10) + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

/** The IST calendar date of a timestamp. */
function istDate(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * The last day a case is still in grace. renewal_grace_ends_at is the moment
 * it lapses (set by the cron, or moved by "Give more time"), so the day
 * before it; with none set, the end date plus the grace setting.
 */
export function graceLastDay(
  c: { end_date: string | null; renewal_grace_ends_at?: string | null },
  graceDays: number,
): string | null {
  if (c.renewal_grace_ends_at) return addDays(istDate(c.renewal_grace_ends_at), -1);
  return c.end_date ? addDays(c.end_date, graceDays) : null;
}

/** The renewal_grace_ends_at that keeps a case in grace through `lastDay` (IST midnight after it). */
export function graceEndsAtFor(lastDay: string): string {
  return new Date(`${addDays(lastDay, 1)}T00:00:00+05:30`).toISOString();
}

export function renewalDeskTab(
  c: { status: string; end_date: string | null; renewal_grace_ends_at?: string | null },
  today: string,
  hasOpenRenewalBill: boolean,
  graceDays: number = DEFAULT_RENEWAL_GRACE_DAYS,
): RenewalDeskTab | null {
  if (!(RENEWAL_DESK_STATUSES as readonly string[]).includes(c.status)) return null;
  if (c.status === "lapsed") return "lapsed";
  if (!c.end_date) return null;

  const days = daysUntil(c.end_date, today);
  if (c.status === "grace_period" || days < 0) {
    const lastDay = graceLastDay(c, graceDays);
    return lastDay && today > lastDay ? "lapsed" : "grace";
  }
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

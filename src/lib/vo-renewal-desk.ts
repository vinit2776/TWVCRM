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

// ---------------------------------------------------------------------------
// Board views beyond the four stages: Active, Renewed, needs-action
// ---------------------------------------------------------------------------

export const RENEWED_WINDOW_DAYS = 60;

export const RENEWAL_BOARD_TABS = ["coming", "due", "grace", "lapsed", "active", "renewed"] as const;
export type RenewalBoardTab = (typeof RENEWAL_BOARD_TABS)[number];

export const RENEWAL_BOARD_TAB_LABELS: Record<RenewalBoardTab, string> = {
  ...RENEWAL_DESK_TAB_LABELS,
  active: "Active",
  renewed: "Renewed",
};

export function renewalBoardTabHint(tab: RenewalBoardTab, graceDays: number): string {
  if (tab === "active") return "Ends later, nothing to do yet";
  if (tab === "renewed") return `Last ${RENEWED_WINDOW_DAYS} days`;
  return renewalDeskTabHint(tab, graceDays);
}

/**
 * The board tab of a case: the desk's four stages, plus Active (live, ending
 * beyond the coming-up window) and Renewed (renewed recently, read from the
 * case's own renewed_at).
 */
export function renewalBoardTab(
  c: {
    status: string;
    end_date: string | null;
    renewal_grace_ends_at?: string | null;
    renewed_at?: string | null;
  },
  today: string,
  hasOpenRenewalBill: boolean,
  graceDays: number = DEFAULT_RENEWAL_GRACE_DAYS,
): RenewalBoardTab | null {
  if (c.status === "renewed") {
    if (!c.renewed_at) return null;
    const ago = daysUntil(today, istDate(c.renewed_at));
    return ago >= 0 && ago <= RENEWED_WINDOW_DAYS ? "renewed" : null;
  }
  const stage = renewalDeskTab(c, today, hasOpenRenewalBill, graceDays);
  if (stage) return stage;
  return c.status === "active" && c.end_date ? "active" : null;
}

/** The first notice goes out this many days before the end date. */
export const FIRST_NOTICE_DAYS = 30;

/**
 * Whether a case needs a person, derived only from what the board already
 * knows: a first notice is due and none was sent, it is in grace, it lapsed
 * with no decision recorded, or a postpaid partner has not confirmed.
 */
export function needsAction(r: {
  tab: RenewalBoardTab;
  days_left: number | null;
  postpaid: boolean;
  partner_confirmed: boolean;
  reminder_count: number;
  lapse_decision: string | null;
}): boolean {
  switch (r.tab) {
    case "active":
    case "renewed":
      return false;
    case "lapsed":
      return !r.lapse_decision;
    case "grace":
      return true;
    case "coming":
    case "due":
      if (r.postpaid) return !r.partner_confirmed;
      return r.reminder_count < 1 && (r.tab === "due" || (r.days_left !== null && r.days_left <= FIRST_NOTICE_DAYS));
  }
}

// ---------------------------------------------------------------------------
// Notice schedule
// ---------------------------------------------------------------------------

export interface NoticeScheduleEntry {
  number: number;
  label: string;
  /** The day it falls due (the end date for the final notice). */
  due_date: string;
  status: "sent" | "pending";
  sent_at: string | null;
  channels: string[];
  /** Pending and already past its due date. */
  overdue: boolean;
}

const NOTICE_PLAN: Array<{ number: number; label: string; daysBefore: number }> = [
  { number: 1, label: "Reminder 1", daysBefore: 30 },
  { number: 2, label: "Reminder 2", daysBefore: 21 },
  { number: 3, label: "Reminder 3", daysBefore: 14 },
  { number: 4, label: "Reminder 4", daysBefore: 7 },
  { number: 5, label: "Final notice", daysBefore: 0 },
];

/** Reminder 1 at 30 days, 2 to 4 at 21, 14 and 7, then the final notice, each sent or pending. */
export function noticeSchedule(
  c: { end_date: string | null },
  reminders: Array<{ reminder_number: number; sent_at: string; email_sent?: boolean; whatsapp_sent?: boolean }>,
  today: string,
): NoticeScheduleEntry[] {
  if (!c.end_date) return [];
  const end = c.end_date.slice(0, 10);
  return NOTICE_PLAN.map((p) => {
    const sent = reminders
      .filter((r) => r.reminder_number === p.number && (r.email_sent || r.whatsapp_sent))
      .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))[0];
    const due = addDays(end, -p.daysBefore);
    return {
      number: p.number,
      label: p.label,
      due_date: due,
      status: sent ? "sent" : "pending",
      sent_at: sent?.sent_at ?? null,
      channels: sent ? [sent.email_sent ? "Email" : null, sent.whatsapp_sent ? "WhatsApp" : null].filter((x): x is string => !!x) : [],
      overdue: !sent && due < today,
    };
  });
}

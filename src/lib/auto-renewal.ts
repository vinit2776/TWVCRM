/**
 * Auto-renewal rules: pure functions, no database access.
 *
 * Nothing here sends anything or changes a contract. The daily job and the
 * contract page both call these so the dates and the "why is this held" reasons
 * can never drift apart.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * off      the job does nothing.
 * dry_run  reports what it would do in an internal digest; changes nothing and
 *          contacts no customer. The default, so scheduling the job cannot by
 *          itself reach anyone. (Same convention as vo_renewal_cron_mode.)
 * live     acts.
 */
export const AUTO_RENEW_CRON_MODE_SETTING = "auto_renew_cron_mode";
export const AUTO_RENEW_MODES = ["off", "dry_run", "live"] as const;
export type AutoRenewMode = (typeof AUTO_RENEW_MODES)[number];

/** Anything missing or unrecognised is a dry run, never live. */
export function parseAutoRenewMode(value: string | null | undefined): AutoRenewMode {
  return (AUTO_RENEW_MODES as readonly string[]).includes(value ?? "")
    ? (value as AutoRenewMode)
    : "dry_run";
}

export interface AutoRenewTiming {
  /** Days before notice #1 that the internal draft is prepared. */
  draftLeadDays: number;
  /** Days before the notice deadline that notice #1 goes out. */
  noticeLeadDays: number;
  /** Days before the end date for the rate confirmation. */
  confirmationDays: number;
}

export const DEFAULT_AUTO_RENEW_TIMING: AutoRenewTiming = {
  draftLeadDays: 7,
  noticeLeadDays: 7,
  confirmationDays: 15,
};

/** Reads the timing settings; a missing or non-numeric value falls back to its default. */
export function parseAutoRenewTiming(settings: Record<string, string | null | undefined>): AutoRenewTiming {
  const num = (key: string, fallback: number) => {
    const n = Number(settings[key]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    draftLeadDays: num("auto_renew_draft_lead_days", DEFAULT_AUTO_RENEW_TIMING.draftLeadDays),
    noticeLeadDays: num("auto_renew_notice_lead_days", DEFAULT_AUTO_RENEW_TIMING.noticeLeadDays),
    confirmationDays: num("auto_renew_confirmation_days", DEFAULT_AUTO_RENEW_TIMING.confirmationDays),
  };
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** What the signed agreement prints when a contract carries no usable percentage. */
export const DEFAULT_ESCALATION_PERCENTAGE = 10;

interface EscalationFields {
  /** The base agreement's escalation, carried unchanged down a renewal chain. */
  agreement_escalation_percentage?: number | string | null;
  /** What was applied to THIS term. A negotiation may set it differently for this term only. */
  escalation_percentage?: number | string | null;
}

/**
 * The escalation the signed base agreement programs for the next renewal.
 *
 * A one-off negotiated rate lives in escalation_percentage for that term only;
 * the next renewal goes back to this figure unless it is negotiated again.
 *
 * A stored 0 or missing value reads as the default, because that is what the
 * agreement PDF prints (`escalation_percentage || 10`), and the signed document
 * is what the customer agreed to.
 */
export function programmedEscalation(c: EscalationFields): number {
  const agreement = Number(c.agreement_escalation_percentage);
  if (Number.isFinite(agreement) && agreement > 0) return agreement;
  const applied = Number(c.escalation_percentage);
  if (Number.isFinite(applied) && applied > 0) return applied;
  return DEFAULT_ESCALATION_PERCENTAGE;
}

/** True when the rate applied to a term differs from the agreement's. */
export function isNegotiatedEscalation(applied: number, programmed: number): boolean {
  return Math.abs(applied - programmed) > 0.0001;
}

// ---------------------------------------------------------------------------
// Notice schedule
// ---------------------------------------------------------------------------

export interface NoticeSchedule {
  /** When the internal draft is prepared (staff get this long to revise before the customer is told). */
  draftOn: string;
  /** When customer notice #1 goes out. The price locks here. */
  noticeOn: string;
  /** Last day the customer can serve notice under the agreement. */
  noticeDeadline: string;
  /** Rate confirmation to the customer, or null when notice #1 is already inside that window. */
  confirmationOn: string | null;
  /** True when notice #1 was pulled earlier to precede the invoice that prices the split month. */
  pulledEarlierForSplitInvoice: boolean;
}

/** The day before the earliest billing-run day (the run covers the 28th to the 31st). */
const LAST_DAY_BEFORE_MONTH_END_RUN = 27;

function parseYmd(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

/** Calendar-month subtraction that clamps to the last day (31 Mar minus 1 month is 28 Feb). */
export function subtractMonthsYmd(ymd: string, months: number): string {
  const d = parseYmd(ymd);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return toYmd(d);
}

function isLastDayOfMonth(ymd: string): boolean {
  return addDaysYmd(ymd, 1).slice(8, 10) === "01";
}

/**
 * Subtracts a notice period that may be fractional (the column is DECIMAL(3,1)):
 * whole months by the calendar, a trailing .5 as 15 days. Any other fraction is
 * rounded to the nearest half month.
 */
export function subtractNoticePeriod(endYmd: string, noticePeriodMonths: number): string {
  const halves = Math.round(noticePeriodMonths * 2);
  const wholeMonths = Math.floor(halves / 2);
  const extraHalf = halves % 2 === 1;
  const afterMonths = subtractMonthsYmd(endYmd, wholeMonths);
  return extraHalf ? addDaysYmd(afterMonths, -15) : afterMonths;
}

/**
 * The dates a contract's auto-renewal runs on, from its end date and the notice
 * period written in its agreement.
 *
 * Notice #1 goes out `noticeLeadDays` before the customer's last day to serve
 * notice, so they always have that long to object. The draft is prepared
 * `draftLeadDays` before that.
 *
 * A term that ends mid-month is billed as one invoice with two rates (old rate
 * to the end date, escalated rate after). That invoice is generated by the
 * month-end run of the PREVIOUS month, so the customer must already have been
 * told by then: notice #1 is pulled to the 27th of that month when the normal
 * date would land after it.
 */
export function computeNoticeSchedule(
  endDate: string,
  noticePeriodMonths: number,
  timing: AutoRenewTiming = DEFAULT_AUTO_RENEW_TIMING,
): NoticeSchedule {
  const noticeDeadline = subtractNoticePeriod(endDate, noticePeriodMonths);
  let noticeOn = addDaysYmd(noticeDeadline, -timing.noticeLeadDays);

  let pulledEarlierForSplitInvoice = false;
  if (!isLastDayOfMonth(endDate)) {
    const startOfEndMonth = `${endDate.slice(0, 8)}01`;
    const prevMonthEnd = addDaysYmd(startOfEndMonth, -1);
    const cap = `${prevMonthEnd.slice(0, 8)}${String(LAST_DAY_BEFORE_MONTH_END_RUN).padStart(2, "0")}`;
    if (noticeOn > cap) {
      noticeOn = cap;
      pulledEarlierForSplitInvoice = true;
    }
  }

  const draftOn = addDaysYmd(noticeOn, -timing.draftLeadDays);
  const confirmation = addDaysYmd(endDate, -timing.confirmationDays);
  return {
    draftOn,
    noticeOn,
    noticeDeadline,
    confirmationOn: confirmation > noticeOn ? confirmation : null,
    pulledEarlierForSplitInvoice,
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type AutoRenewHoldCode =
  | "not_live"
  | "renewal_declined"
  | "exit_in_progress"
  | "overdue"
  | "moratorium"
  | "rent_waiver"
  | "rate_phases"
  | "special_clause_unapproved"
  | "escalation_approval_pending";

export const AUTO_RENEW_HOLD_LABELS: Record<AutoRenewHoldCode, string> = {
  not_live: "Contract is not active",
  renewal_declined: "Renewal was declined",
  exit_in_progress: "Customer exit in progress",
  overdue: "Overdue invoices",
  moratorium: "Active billing moratorium",
  rent_waiver: "Active rent waiver",
  rate_phases: "Tiered rate schedule (needs a person)",
  special_clause_unapproved: "Special clause awaiting approval",
  escalation_approval_pending: "Escalation change awaiting approval",
};

export interface AutoRenewEligibilityInput {
  autoRenew: boolean;
  status: string;
  renewalDeclined: boolean;
  hasLiveExit: boolean;
  /** Total of invoices past due; anything above zero holds the contract. */
  overdueAmount: number;
  hasActiveMoratorium: boolean;
  hasActiveRentWaiver: boolean;
  hasRatePhases: boolean;
  hasUnapprovedSpecialClause: boolean;
  escalationApprovalPending: boolean;
}

export interface AutoRenewEligibility {
  /** Switched on and nothing in the way: the job may prepare and roll it. */
  eligible: boolean;
  /** Reasons a person has to deal with. Empty when eligible or when auto-renewal is off. */
  holds: { code: AutoRenewHoldCode; label: string }[];
}

/**
 * Whether a contract can ride the autopilot. A contract with auto-renewal
 * switched off is not "held": it has no holds and is simply not eligible. Holds
 * only describe contracts that opted in but need a person.
 */
export function evaluateAutoRenewEligibility(input: AutoRenewEligibilityInput): AutoRenewEligibility {
  if (!input.autoRenew) return { eligible: false, holds: [] };

  const codes: AutoRenewHoldCode[] = [];
  if (!["active", "renewal_in_progress"].includes(input.status)) codes.push("not_live");
  if (input.renewalDeclined) codes.push("renewal_declined");
  if (input.hasLiveExit) codes.push("exit_in_progress");
  if (input.overdueAmount > 0) codes.push("overdue");
  if (input.hasActiveMoratorium) codes.push("moratorium");
  if (input.hasActiveRentWaiver) codes.push("rent_waiver");
  if (input.hasRatePhases) codes.push("rate_phases");
  if (input.hasUnapprovedSpecialClause) codes.push("special_clause_unapproved");
  if (input.escalationApprovalPending) codes.push("escalation_approval_pending");

  return {
    eligible: codes.length === 0,
    holds: codes.map((code) => ({ code, label: AUTO_RENEW_HOLD_LABELS[code] })),
  };
}

/** Why auto-renewal was switched off, stored on the contract. */
export const AUTO_RENEW_STOP_REASONS = {
  exitStarted: "Customer notice recorded (exit started)",
  renewalDeclined: "Renewal declined",
} as const;

/** Roles that may switch auto-renewal on, pause it, or revise the next rate (same as manual Renew/Extend). */
export const AUTO_RENEW_MANAGE_ROLES = ["admin", "manager", "sales_rep"] as const;

export const AUTO_RENEW_PAUSE_REASON_PREFIX = "Paused while renegotiating";

export type RevisionCheck = { ok: true } | { ok: false; error: string };

/**
 * Whether a person may set `percentage` as the next term's escalation.
 * A rate below the agreement's needs an admin: reducing the signed escalation is an
 * admin decision on the manual renewal route too. At or above it, any manager role.
 */
export function checkRevision(percentage: number, programmed: number, role: string): RevisionCheck {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    return { ok: false, error: "Enter a percentage between 0 and 100." };
  }
  if (percentage < programmed && isNegotiatedEscalation(percentage, programmed) && role !== "admin") {
    return { ok: false, error: `A rate below the agreement's ${programmed}% needs an admin. Ask an admin to set it.` };
  }
  return { ok: true };
}

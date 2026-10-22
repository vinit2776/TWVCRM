/**
 * What the Virtual Office renewal cron should do with each case.
 *
 * Pure, so the rules are unit testable and the job itself only executes
 * decisions. The old job matched exact days (end_date = today + 30, reminders
 * only when exactly 21, 14 or 7 days were left), so one missed run meant that
 * stage never happened for that case. Here every stage is "due and not yet
 * done", so a skipped day is caught up on the next run.
 *
 * What the job will and will not do on its own:
 * - It never opens a renewal. A person starts it (Start renewal), which raises
 *   the one bill and link and sends the first notice. The job only chases that
 *   bill, on the same link, and only if the first notice actually went out.
 * - It never moves a case to grace or lapse that nobody has been told about.
 * - It never touches a postpaid partner case's status. Those are billed
 *   monthly and have no renewal bill; a person confirms with the partner.
 */
import { addDays, nextRenewalTerm } from "@/lib/vo-renewal-term";
import { escalationFor, type RenewalEscalationMode } from "@/lib/vo-renewal-offer";

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * off      the job does nothing.
 * dry_run  reports what it would do in an internal digest; changes nothing and
 *          contacts no customer. The default, so scheduling the job cannot by
 *          itself reach anyone.
 * live     acts, and sends the internal digest too.
 */
export const VO_RENEWAL_CRON_MODE_SETTING = "vo_renewal_cron_mode";
export const RENEWAL_CRON_MODES = ["off", "dry_run", "live"] as const;
export type RenewalCronMode = (typeof RENEWAL_CRON_MODES)[number];

export const RENEWAL_CRON_MODE_LABELS: Record<RenewalCronMode, string> = {
  off: "Off",
  dry_run: "Dry run (internal digest only)",
  live: "Live (sends reminders)",
};

/** Anything missing or unrecognised is a dry run, never live. */
export function parseCronMode(value: string | null | undefined): RenewalCronMode {
  return (RENEWAL_CRON_MODES as readonly string[]).includes(value ?? "")
    ? (value as RenewalCronMode)
    : "dry_run";
}

// ---------------------------------------------------------------------------
// Reminder stages
// ---------------------------------------------------------------------------

/** Notice 1 is Start renewal's own send; the job sends 2 to 4, then the final notice. */
export const REMINDER_STAGES = [
  { number: 2, daysBefore: 21 },
  { number: 3, daysBefore: 14 },
  { number: 4, daysBefore: 7 },
] as const;
export const FINAL_NOTICE_STAGE = 5;
/** Two notices are never sent closer together than this, however far behind the job is. */
export const MIN_REMINDER_GAP_DAYS = 3;
/** A postpaid partner case is flagged this long before its end date. */
export const PARTNER_FLAG_DAYS = 45;
/** Coming-up window, as on the Renewals desk. */
export const COMING_UP_DAYS = 60;

function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(from.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(to.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

/** The IST calendar date of a timestamp. */
function istDate(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * The reminder to send now, or null.
 *
 * When the job was down and several stages are due, only the latest one is
 * sent (stage 3 straight after stage 1, not 2 and then 3 on consecutive days),
 * and nothing is sent within MIN_REMINDER_GAP_DAYS of the previous notice.
 */
export function dueReminderStage(params: {
  daysLeft: number;
  reminderCount: number;
  lastReminderAt: string | null | undefined;
  today: string;
}): number | null {
  const { daysLeft, reminderCount, lastReminderAt, today } = params;
  // No first notice means no person has chosen to contact the customer.
  if (reminderCount < 1) return null;
  if (daysLeft <= 0) return null;

  const due = REMINDER_STAGES.filter((s) => daysLeft <= s.daysBefore && s.number > reminderCount);
  if (due.length === 0) return null;

  if (lastReminderAt && daysBetweenDates(istDate(lastReminderAt), today) < MIN_REMINDER_GAP_DAYS) {
    return null;
  }
  return due[due.length - 1].number;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface PartnerRenewalIntent {
  term_start: string;
  term_end: string;
}

export interface CronCaseFacts {
  status: string;
  end_date: string | null;
  renewal_notices_enabled: boolean;
  postpaid: boolean;
  renewal_reminder_count: number;
  renewal_last_reminder_at: string | null;
  renewal_grace_ends_at: string | null;
  /** An unpaid renewal bill exists and has a payment link to reuse. */
  has_open_bill: boolean;
  /** Staff recorded that the postpaid partner is continuing. */
  partner_intent: PartnerRenewalIntent | null;
  /** The latest lapse decision recorded on the case, if any. */
  lapse_decision: string | null;
}

export type AttentionReason =
  | "not_started"
  | "never_notified"
  | "no_bill_or_link"
  | "partner_unconfirmed"
  | "lapse_blocked";

export const ATTENTION_LABELS: Record<AttentionReason, string> = {
  not_started: "Ends within 60 days — renewal not started",
  never_notified: "Ended or ending soon — a renewal was never sent to the customer",
  no_bill_or_link: "Marked renewal due but has no open bill or payment link",
  partner_unconfirmed: "Postpaid partner — continuation not confirmed",
  lapse_blocked: "Grace period over, held back because someone recorded the client as paid",
};

export type CronAction =
  | { kind: "reminder"; stage: number }
  | { kind: "final_notice" }
  | { kind: "lapse" }
  | { kind: "partner_roll" }
  | { kind: "attention"; reason: AttentionReason }
  | { kind: "none" };

const LIVE_STATUSES = ["active", "renewal_due", "grace_period"];

export function classifyRenewalCase(c: CronCaseFacts, today: string, nowIso: string): CronAction {
  if (!LIVE_STATUSES.includes(c.status) || !c.end_date) return { kind: "none" };
  // Opt-in is per case: the 58 existing end dates were derived, not agreed.
  if (!c.renewal_notices_enabled) return { kind: "none" };

  const daysLeft = daysBetweenDates(today, c.end_date);

  if (c.postpaid) {
    if (c.partner_intent) {
      return today >= c.partner_intent.term_start ? { kind: "partner_roll" } : { kind: "none" };
    }
    return daysLeft <= PARTNER_FLAG_DAYS
      ? { kind: "attention", reason: "partner_unconfirmed" }
      : { kind: "none" };
  }

  if (c.status === "active") {
    if (daysLeft <= COMING_UP_DAYS) {
      return { kind: "attention", reason: daysLeft < 0 ? "never_notified" : "not_started" };
    }
    return { kind: "none" };
  }

  if (c.status === "renewal_due") {
    if (!c.has_open_bill) return { kind: "attention", reason: "no_bill_or_link" };
    if (c.renewal_reminder_count < 1) {
      // Started but never sent: nothing automatic may be the first contact.
      return daysLeft <= 30 ? { kind: "attention", reason: "never_notified" } : { kind: "none" };
    }
    if (daysLeft <= 0) return { kind: "final_notice" };
    const stage = dueReminderStage({
      daysLeft,
      reminderCount: c.renewal_reminder_count,
      lastReminderAt: c.renewal_last_reminder_at,
      today,
    });
    return stage ? { kind: "reminder", stage } : { kind: "none" };
  }

  // grace_period
  if (c.renewal_grace_ends_at && Date.parse(c.renewal_grace_ends_at) <= Date.parse(nowIso)) {
    if (c.lapse_decision === "paid") return { kind: "attention", reason: "lapse_blocked" };
    return { kind: "lapse" };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Postpaid partner renewal
// ---------------------------------------------------------------------------

export interface PartnerRenewalOffer {
  term: { start: string; end: string };
  durationMonths: number;
  currentRate: number;
  escalationPercentage: number;
  /** The monthly fee from the new term's first billing month. */
  newRate: number;
}

/**
 * A postpaid partner's case is billed monthly from `rate`, so escalation
 * applies to the monthly figure and the duration only sets the term. Whole
 * rupees, as renewalRate() does.
 */
export function partnerRenewalOffer(input: {
  currentMonthlyRate: number;
  agreedEscalationPercentage: number | null | undefined;
  currentEnd: string;
  durationMonths: number;
  mode: RenewalEscalationMode;
  customPercentage?: number | null;
}): PartnerRenewalOffer {
  const escalationPercentage = escalationFor(
    input.mode,
    input.agreedEscalationPercentage,
    input.customPercentage,
  );
  return {
    term: nextRenewalTerm(input.currentEnd, input.durationMonths),
    durationMonths: input.durationMonths,
    currentRate: input.currentMonthlyRate,
    escalationPercentage,
    newRate: Math.round(input.currentMonthlyRate * (1 + escalationPercentage / 100)),
  };
}

/** The partner confirmation kept on cases.metadata.partner_renewal. */
export interface PartnerRenewalRecord extends PartnerRenewalIntent {
  duration_months: number;
  escalation_mode: RenewalEscalationMode;
  escalation_percentage: number;
  escalation_reason: string | null;
  current_rate: number;
  new_rate: number;
  note: string;
  by: string;
  by_name: string | null;
  at: string;
}

export function partnerRenewalRecord(metadata: unknown): PartnerRenewalRecord | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const rec = (metadata as Record<string, unknown>).partner_renewal;
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Partial<PartnerRenewalRecord>;
  return typeof r.term_start === "string" && typeof r.term_end === "string" && typeof r.new_rate === "number"
    ? (r as PartnerRenewalRecord)
    : null;
}

/**
 * Whether a recorded confirmation still describes the case's next term. A
 * case whose end date moved since (an extension, a correction) must be
 * confirmed again rather than rolled on figures nobody saw against that date.
 */
export function partnerRenewalIsCurrent(rec: PartnerRenewalIntent, caseEnd: string): boolean {
  return rec.term_start === addDays(caseEnd, 1);
}

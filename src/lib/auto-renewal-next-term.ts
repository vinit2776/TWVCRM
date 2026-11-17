/**
 * Auto-renewal next term (part 4b-1): when the system prepares the next term, and
 * the checks around it. Pure functions: no database.
 *
 * The next term is the same draft a person would create with Renew, created at the
 * rate the customer was sent. A person then activates it (part 4b-1); the system
 * activating it by itself is part 4b-2.
 */
import { addDaysYmd } from "@/lib/auto-renewal";
import { parseNoticeMode, type NoticeMode } from "@/lib/auto-renewal-notice";

export const ROLL_MODE_SETTING = "auto_renew_roll_mode";

/** off / dry_run / live, read the same way as the notice switch: unrecognised means dry_run. */
export function parseRollMode(value: string | null | undefined): NoticeMode {
  return parseNoticeMode(value);
}

/** Renew opens this many days before expiry, by hand or by the system. */
export const RENEWAL_WINDOW_DAYS = 45;

export interface NextTermInput {
  today: string;
  endDate: string;
  held: boolean;
  /** A renewal draft or live renewal already exists for this term. */
  hasRenewal: boolean;
  /** The rate notice for this term has been emailed, so its rent is locked. */
  rateNoticeSent: boolean;
}

export type NextTermDecision =
  | { prepare: true }
  | { prepare: false; reason: "held" | "already_exists" | "notice_not_sent" | "too_early" | "term_ended" };

/**
 * Whether the job should create the next term today. Only after the customer has been
 * told the rate, from 45 days before the end date (the window Renew itself uses), and
 * never for a contract held for a person.
 */
export function decideNextTerm(i: NextTermInput): NextTermDecision {
  if (i.held) return { prepare: false, reason: "held" };
  if (i.hasRenewal) return { prepare: false, reason: "already_exists" };
  if (!i.rateNoticeSent) return { prepare: false, reason: "notice_not_sent" };
  if (i.today > i.endDate) return { prepare: false, reason: "term_ended" };
  if (i.today < addDaysYmd(i.endDate, -RENEWAL_WINDOW_DAYS)) return { prepare: false, reason: "too_early" };
  return { prepare: true };
}

/** The draft's rent should equal what the customer was told; anything else needs a person to look. */
export function rentMatchesNotice(draftRent: number, noticedRent: number): boolean {
  return Math.abs(draftRent - noticedRent) < 0.5;
}

/** The roll is available to a person from the day the next term starts. */
export function canActivateNow(today: string, rollOn: string): boolean {
  return today >= rollOn;
}

/** Activating the next term moves vouchers and billing, so it stays with admins and managers, as it does today. */
export const NEXT_TERM_ACTIVATE_ROLES = ["admin", "manager"] as const;

/**
 * The standard path for each process, and the sanctioned ways off it.
 *
 * Pure (no Supabase) so the client dialog and the server routes share one set
 * of reasons and rules, and so they unit test.
 *
 * A deviation here is something the app ALLOWS but wants to learn from. It is
 * never a gate: the action goes through, and recording the deviation can't
 * block it. Money safety rules (a walk-in pays before check-in, a locked
 * period stays locked) live in the routes and are unrelated to this file.
 *
 * To bring another process under this: add a key below, call
 * recordDeviation() from the route where someone takes the exception path, and
 * it shows up on the Staff exceptions page with no further wiring.
 */

export interface DeviationReason {
  code: string;
  label: string;
  /** False for reasons that are not the person's doing, e.g. a system outage. */
  countsAgainstPerson: boolean;
}

export interface DeviationDefinition {
  process: string;
  processLabel: string;
  label: string;
  /** What the standard path is, shown to the person taking the exception. */
  standard: string;
  reasons: readonly DeviationReason[];
}

export const BOOKING_LATE_CLOSE_OUT = "booking.late_close_out";

export const PROCESS_DEVIATIONS = {
  [BOOKING_LATE_CLOSE_OUT]: {
    process: "booking",
    processLabel: "Bookings",
    label: "Booking closed out late",
    standard: "Check the customer in on the day, check them out when they leave.",
    reasons: [
      { code: "payment_confusion", label: "Payment confusion", countsAgainstPerson: true },
      { code: "staff_forgot", label: "Staff forgot", countsAgainstPerson: true },
      { code: "system_problem", label: "System or connectivity problem", countsAgainstPerson: false },
      { code: "customer_left", label: "Customer left without staff", countsAgainstPerson: true },
      { code: "other", label: "Other", countsAgainstPerson: true },
    ],
  },
} as const satisfies Record<string, DeviationDefinition>;

export type DeviationKey = keyof typeof PROCESS_DEVIATIONS;

export function deviationDefinition(key: string): DeviationDefinition | null {
  return (PROCESS_DEVIATIONS as Record<string, DeviationDefinition>)[key] ?? null;
}

export function findReason(key: string, code: string): DeviationReason | null {
  return deviationDefinition(key)?.reasons.find((r) => r.code === code) ?? null;
}

export const REVIEW_OUTCOMES = [
  { value: "coaching_done", label: "Coaching done" },
  { value: "process_fix", label: "Process needs fixing" },
  { value: "fine_as_is", label: "Fine as is" },
] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number]["value"];

export function isReviewOutcome(v: unknown): v is ReviewOutcome {
  return REVIEW_OUTCOMES.some((o) => o.value === v);
}

// ── Booking close-out rules ────────────────────────────────────────────────

/** Minimum comment length when the reason is "Other". */
export const OTHER_COMMENT_MIN_LENGTH = 10;

const IST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });

/** A date as YYYY-MM-DD in IST. */
export function istDate(d: Date): string {
  return IST_DATE.format(d);
}

/** Whole days between two YYYY-MM-DD dates (to - from). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** How many days after its date the booking is, in IST. 0 on the day itself. */
export function daysPastBooking(bookingDate: string, now: Date): number {
  return Math.max(0, daysBetween(bookingDate, istDate(now)));
}

export type CloseOutDecision =
  | { allowed: true; daysLate: number }
  | { allowed: false; error: string };

/**
 * Whether a booking can be closed out. Only past-dated bookings: on the day
 * itself the normal check-in/check-out flow applies. A checked-in booking is
 * left alone for a further day, since a late session can legitimately run past
 * midnight.
 */
export function closeOutDecision(
  booking: { status: string; booking_date: string; customer_type: string },
  now: Date,
): CloseOutDecision {
  if (booking.customer_type === "contract_holder") {
    return {
      allowed: false,
      error: "Contract bookings are billed through the monthly statement. Ask an admin to close this one.",
    };
  }
  const daysLate = daysPastBooking(booking.booking_date, now);
  if (booking.status === "confirmed") {
    if (daysLate < 1) {
      return { allowed: false, error: "This booking is today. Use Check In and Check Out." };
    }
    return { allowed: true, daysLate };
  }
  if (booking.status === "checked_in") {
    if (daysLate < 2) {
      return { allowed: false, error: "This session may still be running. Use Check Out." };
    }
    return { allowed: true, daysLate };
  }
  return { allowed: false, error: `A ${booking.status.replace("_", " ")} booking can't be closed out.` };
}

export interface CloseOutInput {
  outcome: "used" | "no_show";
  reason_code: string;
  comment: string;
  accountable_user_id: string | null;
}

export function validateCloseOut(raw: Record<string, unknown>):
  | { ok: true; value: CloseOutInput }
  | { ok: false; error: string } {
  const outcome = raw.outcome;
  if (outcome !== "used" && outcome !== "no_show") {
    return { ok: false, error: "Say whether the customer used the room or didn't come" };
  }
  const reasonCode = typeof raw.reason_code === "string" ? raw.reason_code : "";
  if (!findReason(BOOKING_LATE_CLOSE_OUT, reasonCode)) {
    return { ok: false, error: "Pick why this wasn't handled on the day" };
  }
  const comment = typeof raw.comment === "string" ? raw.comment.trim() : "";
  if (reasonCode === "other" && comment.length < OTHER_COMMENT_MIN_LENGTH) {
    return { ok: false, error: `Say what happened, in at least ${OTHER_COMMENT_MIN_LENGTH} characters` };
  }
  const accountable =
    typeof raw.accountable_user_id === "string" && raw.accountable_user_id.trim()
      ? raw.accountable_user_id.trim()
      : null;
  return { ok: true, value: { outcome, reason_code: reasonCode, comment, accountable_user_id: accountable } };
}

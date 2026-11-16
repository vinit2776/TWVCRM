/**
 * Open → Answered → Closed, and what happens to a query when its bill is paid.
 *
 * Pure — no Supabase, no mailer — so the rules are unit-testable
 * (src/lib/__tests__/queries-lifecycle.test.ts). The stored status stays
 * 'open' | 'resolved'; "Answered" is derived, never stored, so it can't drift
 * from the conversation it describes.
 *
 * Payment never closes a query on the spot. The asker is nudged once, given
 * PAID_QUERY_GRACE_DAYS to confirm, and only then — and only if the thread
 * shows it was about the amount/invoice and nobody has spoken since the
 * payment — is it closed as "Resolved by payment".
 */

export type QueryLifecycleState = "open" | "answered" | "closed";

/** Days the asker gets after the "bill paid, please confirm" nudge. */
export const PAID_QUERY_GRACE_DAYS = 3;

/** Why a query was closed by the system rather than a person. */
export type QueryResolutionKind = "payment";

export interface LifecycleMessage {
  event_type: string;
  created_at: string;
  created_by: string;
}

/** Events that are someone actually speaking, as opposed to bookkeeping. */
const SPEAKING_EVENTS: readonly string[] = ["message", "payment_not_found"];

/**
 * The last person to say something. Skips automatic events (nudges, the
 * paid-bill reminder, the auto-close) because those are stamped with the asker
 * as a stand-in author — counting them would make the asker look like they had
 * just answered themselves.
 */
export function lastSpeaker(messages: LifecycleMessage[]): LifecycleMessage | null {
  const spoken = messages
    .filter((m) => SPEAKING_EVENTS.includes(m.event_type))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return spoken[spoken.length - 1] ?? null;
}

export function deriveLifecycleState(input: {
  status: "open" | "resolved";
  created_by_id: string;
  messages: LifecycleMessage[];
}): { state: QueryLifecycleState; answeredById: string | null } {
  if (input.status === "resolved") return { state: "closed", answeredById: null };
  const last = lastSpeaker(input.messages);
  if (last && last.created_by !== input.created_by_id) {
    return { state: "answered", answeredById: last.created_by };
  }
  return { state: "open", answeredById: null };
}

export type PaidQueryAction =
  /** Leave it alone. */
  | "none"
  /** Send the asker the one nudge. */
  | "nudge"
  /** Close it as resolved by payment. */
  | "auto_close"
  /** Not safe to auto-close; keep it visibly open as "bill paid, query still open". */
  | "flag_only";

export interface PaidQueryInput {
  status: "open" | "resolved";
  /** When the bill became fully paid (latest payment). Null while unpaid. */
  billPaidAt: string | null;
  /** True once the bill was corrected (amount / invoice edit) while this query was open. */
  billCorrected: boolean;
  /** Set once the one nudge has been sent. */
  paidNudgedAt: string | null;
  messages: LifecycleMessage[];
  now: Date;
}

function daysBetween(from: string, to: Date): number {
  return (to.getTime() - new Date(from).getTime()) / 86_400_000;
}

export function decidePaidQuery(input: PaidQueryInput): PaidQueryAction {
  if (input.status !== "open" || !input.billPaidAt) return "none";

  // A person reopened it after a close: they want it open. Never auto-close it
  // again, and don't pester them with another nudge.
  if (input.messages.some((m) => m.event_type === "reopened")) return "flag_only";

  // Without evidence the query was about the amount/invoice (the bill was
  // corrected), we can't tell it from a documents or vendor-details question,
  // which payment doesn't answer. Those never auto-close.
  if (!input.billCorrected) return "flag_only";

  const spokeAfterPayment = input.messages.some(
    (m) => SPEAKING_EVENTS.includes(m.event_type) && m.created_at > input.billPaidAt!,
  );

  if (!input.paidNudgedAt) return "nudge";

  // Anything said after the payment — before or after the nudge — means a
  // person is still talking about it. Leave it for them.
  if (spokeAfterPayment) return "flag_only";

  if (daysBetween(input.paidNudgedAt, input.now) >= PAID_QUERY_GRACE_DAYS) return "auto_close";
  return "none";
}

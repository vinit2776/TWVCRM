/**
 * Pure helpers for the consolidated payment reminder: one email per customer
 * carrying every due/overdue invoice, instead of one email per invoice.
 *
 * No I/O here so the grouping rules can be unit-tested; the send itself lives
 * in payment-reminder.ts.
 */

/** Most invoices attached to one reminder. The rest are listed, not attached. */
export const MAX_REMINDER_ATTACHMENTS = 5;

export interface ReminderCandidate<T> {
  /** The billing_statements row (opaque to this module). */
  statement: T;
  /** Identifies the customer — see reminderLeadKey. */
  leadKey: string;
  /** Days past due_date. Only statements already due (>= 0) are candidates. */
  daysOverdue: number;
  /** Whether this statement's own ladder + throttle says "send now". */
  gatePass: boolean;
}

export interface ReminderGroup<T> {
  leadKey: string;
  /** Oldest-overdue first. Index 0 drives tone, CC and WhatsApp. */
  members: ReminderCandidate<T>[];
}

/**
 * The customer a statement belongs to. The lead id when there is one, else the
 * lower-cased email, else the statement itself — so a statement with no
 * identifiable owner is never merged into someone else's reminder.
 */
export function reminderLeadKey(
  lead: { id?: string | null; email?: string | null } | null | undefined,
  statementId: string,
): string {
  if (lead?.id) return `lead:${lead.id}`;
  const email = lead?.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  return `stmt:${statementId}`;
}

/**
 * Groups candidates by customer and keeps only the groups that should send.
 *
 * A group sends when ANY member's own gate passes — a statement hitting a new
 * stage pulls every other due invoice into the same email, which is what stops
 * the customer receiving a separate email per invoice. Members are ordered
 * oldest-overdue first, so the primary (index 0) is the most overdue one.
 */
export function groupForConsolidatedReminder<T>(
  candidates: ReminderCandidate<T>[],
): { send: ReminderGroup<T>[]; held: ReminderGroup<T>[] } {
  const byKey = new Map<string, ReminderCandidate<T>[]>();
  for (const c of candidates) {
    const list = byKey.get(c.leadKey);
    if (list) list.push(c); else byKey.set(c.leadKey, [c]);
  }
  const send: ReminderGroup<T>[] = [];
  const held: ReminderGroup<T>[] = [];
  for (const [leadKey, list] of byKey) {
    const members = [...list].sort((a, b) => b.daysOverdue - a.daysOverdue);
    (members.some((m) => m.gatePass) ? send : held).push({ leadKey, members });
  }
  return { send, held };
}

/** Splits invoices into those to attach and how many are only listed. */
export function splitAttachable<T>(items: T[], max = MAX_REMINDER_ATTACHMENTS): { attach: T[]; omitted: number } {
  return { attach: items.slice(0, max), omitted: Math.max(0, items.length - max) };
}

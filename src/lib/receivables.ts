/**
 * Shared definition of the non-statement receivables — proposal security
 * deposits, deposit top-ups, and ad-hoc proforma invoices.
 *
 * AR (the page + its API) and the reminder cron both read from here so the
 * two can never disagree about what is collectible, what is overdue, or
 * which ladder applies.
 */

/** Days after a payment link is sent before a deposit is considered due. */
export const DEPOSIT_DUE_DAYS = 7;

/** An invoice older than this is almost certainly abandoned and needs triage. */
export const STALE_AFTER_DAYS = 90;

export type ReceivableKind = "statement" | "deposit" | "topup" | "adhoc_invoice";

/**
 * Deposits and top-ups use the soft ladder: stages 0-2 only (friendly →
 * gentle → firm, accounts CC'd at the last rung). No URGENT tone, no
 * management CC, no perpetual re-fire. Collecting a deposit — especially a
 * renewal-escalation shortfall, which never blocks activation — is routine
 * follow-up, not debt collection.
 */
export const SOFT_LADDER_MAX_STAGE = 2;

export function ladderMaxStageFor(kind: ReceivableKind): number | null {
  switch (kind) {
    case "deposit":
    case "topup":
      return SOFT_LADDER_MAX_STAGE;
    case "adhoc_invoice":
    case "statement":
      return null; // full ladder
  }
}

export const RECEIVABLE_KIND_LABELS: Record<ReceivableKind, string> = {
  statement: "Invoice",
  deposit: "Security deposit",
  topup: "Deposit top-up",
  adhoc_invoice: "Ad-hoc invoice",
};

/** A receivable normalised across all four source tables for the AR list. */
export interface ReceivableRow {
  id: string;
  kind: ReceivableKind;
  /** Human reference — statement no., proposal no., invoice no., contract no. */
  reference: string;
  party_name: string;
  lead_id: string | null;
  lead_email: string | null;
  total_amount: number;
  amount_paid: number;
  balance_due: number;
  due_date: string | null;
  days_overdue: number | null;
  payment_link_url: string | null;
  /** True once past STALE_AFTER_DAYS — surfaced in AR for triage. */
  is_stale: boolean;
  /**
   * False when this row is deliberately excluded from automated dunning
   * (the pre-existing PI backlog). AR still shows it for manual chasing.
   */
  followup_enabled: boolean;
  reminder_count: number;
  last_reminder_sent_at: string | null;
  /** Deep link to the record this receivable came from. */
  href: string | null;
  /** Owning record's id where the receivable is a child — the contract for
   *  a top-up. Needed to address the settle endpoint. */
  parent_id?: string | null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Today in IST as a YYYY-MM-DD anchor — matches the AR/billing convention. */
export function todayIst(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function daysOverdue(dueDate: string | null): number | null {
  if (!dueDate) return null;
  const todayMs = Date.parse(todayIst() + "T00:00:00Z");
  const dueMs = Date.parse(dueDate.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(dueMs)) return null;
  return Math.floor((todayMs - dueMs) / 86400000);
}

export function isStale(dueDate: string | null): boolean {
  const d = daysOverdue(dueDate);
  return d !== null && d >= STALE_AFTER_DAYS;
}

export interface DepositChaseInput {
  status: string | null | undefined;
  /** Set once a Razorpay deposit link has been generated for the proposal. */
  deposit_razorpay_link_id?: string | null;
  /** Set when an admin withdrew that link. */
  deposit_link_cancelled_at?: string | null;
}

/**
 * Is this deposit ours to chase?
 *
 * Acceptance was the only test, on the reasoning that chasing a deposit on an
 * unaccepted proposal is pestering a prospect over money they never agreed to
 * pay. That holds right up until someone sends them a payment link — at which
 * point we have asked for the money in as concrete a way as exists, and
 * staying silent isn't restraint, it's just losing track.
 *
 * Two proposals sat in exactly that state: sent, link issued, due date lapsed
 * in April, and nothing chasing them because they had never been marked
 * accepted.
 *
 * Still deliberately excluded:
 *
 *   draft     — the proposal has not gone out. A link may exist because
 *               someone generated one early; that is a reason to cancel it,
 *               not to start dunning a prospect who has seen nothing.
 *   rejected  — the deal is dead. Chasing here is worse than useless, and the
 *               live link on such a proposal is a hazard to withdraw rather
 *               than a receivable to pursue.
 *   cancelled link — an admin has withdrawn the demand. The deposit may still
 *               be owed, but not by that link and not on this ladder.
 */
export function depositIsChaseable(input: DepositChaseInput | string | null | undefined): boolean {
  // Callers used to pass the bare status. Keep that working rather than make
  // the narrower behaviour the silent default for anyone not yet updated.
  if (typeof input === "string" || input == null) return input === "accepted";

  if (input.deposit_link_cancelled_at) return false;
  if (input.status === "accepted") return true;
  return (
    (input.status === "sent" || input.status === "viewed") && !!input.deposit_razorpay_link_id
  );
}

/**
 * The reference a billing statement is known by on screen.
 *
 * Once a GST invoice exists it always wins: that is the number on the
 * document the customer holds, and it is what the AR row, the proforma link
 * and every email show. The statement number is an internal handle that stops
 * being the thing anyone says out loud.
 *
 * Centralised because the two disagreeing is worse than either choice. The
 * report dialog's invoice picker offered "TWV-BS-0103" while the AR row for
 * the same invoice read "TWV/INV/26-27/0004", so someone reported a payment
 * against one name and then could not find it under the other.
 */
export function statementReference(row: {
  statement_number?: string | null;
  gst_invoice_number?: string | null;
}): string {
  return row.gst_invoice_number || row.statement_number || "Draft";
}

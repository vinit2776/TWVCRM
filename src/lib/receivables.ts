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

/**
 * A deposit is only chaseable once the customer has actually accepted the
 * proposal. Chasing a deposit on a rejected or still-open proposal is
 * pestering a prospect over money they never agreed to pay.
 */
export function depositIsChaseable(proposalStatus: string | null | undefined): boolean {
  return proposalStatus === "accepted";
}

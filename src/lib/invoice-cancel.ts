/**
 * Who may cancel an invoice from Accounts Receivable, and what kind of cancel
 * it is.
 *
 * Cancelling withdraws a document the customer already holds, so it sits with
 * admin and manager. Accounts deliberately cannot start one — they only act on
 * the credit-note task a GST cancellation creates.
 */
export const INVOICE_CANCEL_ROLES = ["admin", "manager"] as const;

export function canCancelInvoice(role: string | null | undefined): boolean {
  return !!role && (INVOICE_CANCEL_ROLES as readonly string[]).includes(role);
}

export interface CancelClassifyInput {
  status: string;
  payment_status: string | null;
  voided_at?: string | null;
  gst_invoice_number: string | null;
  tally_invoice_number?: string | null;
  issuance_channel?: string | null;
  proposal_id?: string | null;
  case_id?: string | null;
  aggregator_id?: string | null;
}

export type CancelKind =
  /** A CRM proforma: cancelled immediately, no Tally step. */
  | "pi"
  /** Not cancellable from here — `reason` says why. */
  | "unavailable";

export interface CancelClassification {
  kind: CancelKind;
  reason?: string;
}

export function classifyForCancel(s: CancelClassifyInput): CancelClassification {
  if (s.voided_at || s.status === "voided") return { kind: "unavailable", reason: "This invoice is already cancelled." };
  if (!["finalized", "exported"].includes(s.status)) {
    return { kind: "unavailable", reason: "Only a sent invoice can be cancelled. Discard a draft instead." };
  }
  if (s.payment_status === "paid" || s.payment_status === "written_off") {
    return { kind: "unavailable", reason: "This invoice is already settled." };
  }
  if (s.proposal_id || s.case_id || s.aggregator_id) {
    return {
      kind: "unavailable",
      reason: "Proposal, case and aggregator invoices are cancelled from their own screen.",
    };
  }
  if (s.gst_invoice_number || s.tally_invoice_number || s.issuance_channel === "tally") {
    return { kind: "unavailable", reason: "GST invoices need a credit note — not available here yet." };
  }
  return { kind: "pi" };
}

/**
 * Tally handoff v2 — shared types and helpers for the Accounts Inbox.
 *
 * See docs/tally-handoff-redesign.md §5 for the state model.
 *
 * `handoff_state` is the accounts-workflow state, separate from the system
 * columns (`lifecycle_stage`, `payment_status`, `issuance_channel`). Until
 * PR #2c starts writing to it, the column will be NULL for existing rows.
 */

export const HANDOFF_STATES = [
  "pi_awaiting_payment",
  "pi_paid_awaiting_gst",
  "direct_gst_requested",
  "name_check_pending",
  "ready_to_send",
  "gst_sent",
  "gst_sent_awaiting_payment",
  "paid_awaiting_receipt_record",
  "complete",
] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

/** Human-readable label for the inbox UI. */
export const HANDOFF_STATE_LABELS: Record<HandoffState, string> = {
  pi_awaiting_payment: "PI sent, awaiting payment",
  pi_paid_awaiting_gst: "PI paid, awaiting GST invoice",
  direct_gst_requested: "Direct GST invoice requested",
  name_check_pending: "Name check pending",
  ready_to_send: "Ready to send to customer",
  gst_sent: "GST invoice sent",
  gst_sent_awaiting_payment: "GST sent, awaiting payment",
  paid_awaiting_receipt_record: "Paid, awaiting receipt entry in Tally",
  complete: "Complete",
};

/**
 * Which task bucket does this state belong to?
 * Drives the stat cards + filter tabs on the inbox.
 */
export type HandoffBucket = "gst_to_issue" | "payment_to_record" | "discrepancy" | "in_flight" | "complete";

export function bucketFor(state: HandoffState | null | undefined, hasDiscrepancy = false): HandoffBucket | null {
  if (!state) return null;
  if (hasDiscrepancy) return "discrepancy";
  switch (state) {
    case "pi_paid_awaiting_gst":
    case "direct_gst_requested":
      return "gst_to_issue";
    case "paid_awaiting_receipt_record":
      return "payment_to_record";
    case "name_check_pending":
    case "ready_to_send":
    case "gst_sent":
    case "gst_sent_awaiting_payment":
    case "pi_awaiting_payment":
      return "in_flight";
    case "complete":
      return "complete";
  }
}

/** States that should be visible on the inbox by default (everything except complete). */
export const INBOX_OPEN_STATES: HandoffState[] = HANDOFF_STATES.filter((s) => s !== "complete") as HandoffState[];

/** Roles permitted to see the inbox. */
export const INBOX_ROLES = ["accounts", "admin", "office_admin", "manager"] as const;
export type InboxRole = (typeof INBOX_ROLES)[number];

export function isInboxRole(role: string | null | undefined): role is InboxRole {
  return !!role && (INBOX_ROLES as readonly string[]).includes(role);
}

/** Aging threshold beyond which inbox items get escalation flagging. */
export const AGING_ESCALATE_HOURS = 48;

// -----------------------------------------------------------------------------
// API response shape — consumed by the inbox-client component.
// -----------------------------------------------------------------------------

export interface InboxLead {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  gst_number: string | null;
}

export interface InboxContract {
  id: string;
  contract_number: string;
  title: string | null;
  billing_mode: "proforma_first" | "gst_direct" | null;
  lead: InboxLead | null;
}

export interface InboxUpload {
  id: string;
  tally_invoice_number: string;
  tally_invoice_series: "SDIPL-REG" | "SDIPL-UNREG";
  irn: string | null;
  invoice_amount: number;
  uploaded_at: string;
  name_check_status: "pending" | "approved" | "overridden";
  autofill_source: "qr" | "pdf_text" | "bridge_match" | "manual";
}

export interface InboxSnapshot {
  voucher_master_id: string;
  invoice_number: string | null;
  voucher_amount: number | null;
  irn: string | null;
  match_confidence: "exact" | "probable" | "unmatched" | null;
  last_synced_at: string;
}

export interface InboxRow {
  statement_id: string;
  statement_number: string | null;
  statement_total_amount: number;
  period_start: string | null;
  period_end: string | null;
  payment_status: string;
  handoff_state: HandoffState;
  bucket: HandoffBucket;
  aging_hours: number;
  state_changed_at: string;
  contract: InboxContract | null;
  latest_upload: InboxUpload | null;
  latest_snapshot: InboxSnapshot | null;
  has_discrepancy: boolean;
  discrepancy_reason: string | null;
}

export interface InboxStats {
  gst_to_issue: number;
  payments_to_record: number;
  discrepancies: number;
  aging_over_48h: number;
  total_open: number;
}

export interface InboxResponse {
  stats: InboxStats;
  rows: InboxRow[];
  last_synced_at: string | null;
}

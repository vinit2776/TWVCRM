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

export function bucketForBooking(state: BookingHandoffState | null | undefined, hasDiscrepancy = false): HandoffBucket {
  if (hasDiscrepancy) return "discrepancy";
  if (state === "gst_to_issue" || state === "ready_to_send") return "gst_to_issue";
  if (state === "complete") return "complete";
  return "in_flight";
}

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

/**
 * States worth showing on the interactive Tally Inbox worklist itself.
 * Excludes states that have no available action in the inbox UI — pure
 * spectate/wait states, not something accounts can act on from this page:
 *   - `pi_awaiting_payment`: can't issue a GST invoice before payment, and
 *     can't record the payment from here either. Tracked for follow-up in
 *     Accounts Receivable instead.
 *   - `name_check_pending`: set right after a GST invoice upload while the
 *     bridge/name-check job runs; no manual approve/override action exists
 *     in the inbox, it resolves on its own once the check completes.
 * `INBOX_OPEN_STATES` (all non-complete states) is still used as-is for the
 * digest cron, which is about reminding accounts of pending items, not
 * about worklist actionability.
 */
export const INBOX_ACTIONABLE_STATES: HandoffState[] = INBOX_OPEN_STATES.filter(
  (s) => s !== "pi_awaiting_payment" && s !== "name_check_pending"
);

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
  billing_emails?: string[] | null;
}

export interface InboxContract {
  id: string;
  contract_number: string;
  title: string | null;
  billing_mode: "proforma_first" | "gst_direct" | null;
  lead: InboxLead | null;
}

/** Owner of a statement that hasn't converted into a contract yet — the
 *  proposal's own first-month pro-rata PI. Always behaves like a
 *  proforma_first flow (no billing_mode concept exists at proposal stage). */
export interface InboxProposal {
  id: string;
  proposal_number: string;
  lead: InboxLead | null;
}

/** Owner of a statement created from an ad-hoc lead invoice (proforma_invoices) —
 *  no contract or proposal exists, always behaves like a proforma_first flow. */
export interface InboxInvoice {
  id: string;
  invoice_number: string;
  /** The invoice's own title — often clearer than a free-typed line-item
   *  description (e.g. "Security Deposit - Add on Seat" vs. "SD - Additional Seat"). */
  title: string | null;
  /** Internal-only context for accounts, never sent to the customer. */
  internal_notes: string | null;
  lead: InboxLead | null;
}

export interface InboxAggregator {
  id: string;
  name: string;
  primary_email: string | null;
  primary_phone: string | null;
  gst_number: string | null;
}

/** Owner of a per-case Virtual Office statement (prepaid aggregator or direct
 *  client) — no contract or proposal exists, always gst_direct (no PI). */
export interface InboxCase {
  id: string;
  case_number: string;
  client_name: string;
  client_company_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  client_gst_number: string | null;
  aggregator: InboxAggregator | null;
}

export interface InboxPayment {
  id: string;
  amount: number;
  payment_date: string;
  payment_mode: string;
  payment_reference: string | null;
  notes: string | null;
  razorpay_payment_id: string | null;
  recorded_by_name: string | null;
  // Razorpay settlement (from razorpay_settlement_cache)
  settled: boolean | null;
  settled_at: string | null;
  settlement_utr: string | null;
}

export interface InboxTaxBreakup {
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  is_interstate: boolean;
  place_of_supply: string | null;
  hsn_sac_code: string | null;
}

export interface InboxLineItemBreakdown {
  /** statement_type tells us what's expected: 'rent' / 'usage' / 'combined'. */
  statement_type: "rent" | "usage" | "combined" | null;
  fixed_amount: number;           // rent portion
  usage_amount: number;            // total usage (service + booking)
  service_usage_amount: number;    // print, electricity, etc.
  booking_usage_amount: number;    // ad-hoc booking charges
  period_start: string | null;
  period_end: string | null;
}

/**
 * One real, individually-described charge — sourced from whichever of
 * billing_statements.line_items (structured JSONB) / the usage_charges
 * table actually has the data, same priority order proforma-pdf uses.
 * This is what accounts needs to see to know exactly what they're billing,
 * not just a category total like "Usage charges: ₹648".
 */
export interface InboxItemizedCharge {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  notes: string | null;
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

export type TimelineEventKind =
  | "statement_created"
  | "pi_sent"
  | "payment_received"
  | "gst_uploaded"
  | "gst_sent"
  | "state_changed"
  | "voided";

export interface TimelineEvent {
  kind: TimelineEventKind;
  at: string; // ISO timestamp
  label: string; // human-readable one-line summary
  details: Record<string, unknown>; // structured context (amount, mode, etc.)
}

export interface InboxRow {
  statement_id: string;
  statement_number: string | null;
  statement_total_amount: number;
  period_start: string | null;
  period_end: string | null;
  payment_status: string;
  handoff_state: HandoffState | null;
  bucket: HandoffBucket;
  aging_hours: number;
  state_changed_at: string;
  is_voided: boolean;
  voided_at: string | null;
  void_reason: string | null;
  /** True when the proforma was cancelled via the early-GST override. Distinguishes
   *  the override path from the normal proforma_first path at terminal states. */
  pi_was_cancelled: boolean;
  /** Set once a Tally-issued invoice has been cancelled via the manual
   *  credit-note upload flow (see upload-credit-note/route.ts). */
  lifecycle_stage: string | null;
  tally_credit_note_number: string | null;
  contract: InboxContract | null;
  proposal: InboxProposal | null;
  invoice: InboxInvoice | null;
  /** Per-case VO statement (prepaid aggregator / direct client). */
  case: InboxCase | null;
  /** Postpaid aggregator consolidated statement (many cases bundled). */
  aggregator: InboxAggregator | null;
  latest_upload: InboxUpload | null;
  latest_snapshot: InboxSnapshot | null;
  has_discrepancy: boolean;
  discrepancy_reason: string | null;
  /** Open billing_queries thread count for this statement — drives the
   *  "Query" button badge in the Tally Inbox. See src/lib/billing-queries.ts. */
  open_query_count: number;
  /** Present only when the request specified `?include=timeline`. */
  timeline_events?: TimelineEvent[];

  // Detail fields (PR #2-followup): help accounts issue the GST invoice in Tally
  // without having to leave the inbox.
  irn_required: boolean;             // true iff lead.gst_number is present (A-series)
  expected_series: "SDIPL-REG" | "SDIPL-UNREG";
  expected_prefix: string;           // e.g. "SD/A/" or "SD/B/"
  tax: InboxTaxBreakup;
  line_items: InboxLineItemBreakdown;
  /** Real per-charge breakdown (description/qty/rate/notes) — empty when
   *  neither structured line_items nor usage_charges rows exist. */
  itemized_charges: InboxItemizedCharge[];
  payments_received: InboxPayment[]; // empty array if none yet
  total_paid: number;                // sum of payments_received amounts
  /** ISO timestamp of the last time the GST invoice email was successfully sent. */
  gst_invoice_sent_at: string | null;
}

// -----------------------------------------------------------------------------
// Booking GST tasks — non-contract (walk-in/guest) booking inbox rows.
// These rows appear in the same inbox worklist but are anchored to a booking,
// not a billing_statement.
// -----------------------------------------------------------------------------

export type BookingHandoffState = "gst_to_issue" | "ready_to_send" | "complete";

export interface BookingPaymentConfirmation {
  id: string;
  amount: number;
  payment_mode: string;
  payment_reference: string | null;
  razorpay_payment_id: string | null;
  created_at: string;
  status: string;
  verification_notes: string | null;
  screenshot_path: string | null;
  // Razorpay settlement (from razorpay_settlement_cache)
  settled: boolean | null;
  settled_at: string | null;
  settlement_utr: string | null;
}

export interface BookingInboxAddon {
  id: string;
  description: string;
  addon_type: string;
  quantity: number;
  unit_price: number;
  amount: number;
  gst_rate: number;
  gst_amount: number;
  total_with_gst: number;
  unit_label: string | null;
}

export interface BookingInboxRow {
  row_type: "booking";
  task_id: string;
  booking_id: string;
  booking_number: string | null;
  booking_date: string | null;
  start_time: string | null;
  end_time: string | null;
  check_in_at: string | null;
  check_out_at: string | null;
  duration_hours: number | null;
  pricing_model: string | null;
  base_amount: number;
  gst_amount: number;
  gst_rate: number;
  addons: BookingInboxAddon[];
  space_name: string | null;
  location_name: string | null;
  statement_total_amount: number;   // total_amount_with_gst (GST-inclusive)
  payment_status: string;
  handoff_state: BookingHandoffState;
  bucket: HandoffBucket;
  aging_hours: number;
  state_changed_at: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  lead_id: string | null;
  lead_id_proof_path: string | null;
  lead_billing_emails: string[] | null;
  customer_gstin: string | null;
  irn_required: boolean;
  expected_series: "SDIPL-REG" | "SDIPL-UNREG";
  expected_prefix: string;
  latest_upload: InboxUpload | null;
  has_discrepancy: boolean;
  discrepancy_reason: string | null;
  gst_invoice_sent_at: string | null;
  payment_confirmations: BookingPaymentConfirmation[];
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
  booking_rows: BookingInboxRow[];
  last_synced_at: string | null;
  /** Closed-tab pagination */
  has_more?: boolean;
  total_closed?: number;
}

// -----------------------------------------------------------------------------
// Autofill (PR #4) — shared between the extract endpoint, server helper,
// and the upload form's prefill flow.
// -----------------------------------------------------------------------------

export type AutofillSource = "qr" | "pdf_text" | "bridge_match" | "manual";

/** Subset of the upload form's fields that can be auto-extracted. */
export interface ExtractedFields {
  invoice_number?: string;
  series?: "SDIPL-REG" | "SDIPL-UNREG";
  irn?: string;
  party_gstin?: string;
  party_name?: string;
  invoice_date?: string; // YYYY-MM-DD
  invoice_amount?: number;
}

export interface ExtractResponse {
  source: AutofillSource;
  fields: ExtractedFields;
  /** First 200 chars of extracted text; helps accounts debug a bad parse. */
  raw_text_snippet: string | null;
  /** True iff a tally_voucher_snapshots row matched the extracted number. */
  bridge_match: boolean;
}

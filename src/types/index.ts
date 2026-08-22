// ==========================================
// Location Types
// ==========================================

export interface LocationCapacityConfig {
  open_desk?: number;       // Open floor / hot desk seats
  private_cabin?: number;   // Private cabins / offices
  meeting_room?: number;    // Small meeting room seats
  conference_room?: number; // Large conference room seats
}

export interface Location {
  id: string;
  name: string;
  code: string;
  address?: string;
  city?: string;
  state?: string;
  is_active: boolean;
  capacity_config?: LocationCapacityConfig;
  requires_headcount: boolean;
  latitude?: number | null;
  longitude?: number | null;
  // Up to 2 designated in-charge users — primary recipients for cleaning
  // alerts on checkout and headcount push notifications for this location.
  incharge_user_id_1?: string | null;
  incharge_user_id_2?: string | null;
  incharge_1?: Pick<User, "id" | "full_name" | "email" | "role"> | null;
  incharge_2?: Pick<User, "id" | "full_name" | "email" | "role"> | null;
  /** Set only for locations managed via the UniFi API (e.g. Nungambakkam LGF). */
  unifi_site_id?: string | null;
  /** UniFi cloud console UUID — falls back to UNIFI_CONSOLE_ID env var when null. */
  unifi_console_id?: string | null;
  /** 'repository' (default) = issue from pre-uploaded pool; 'unifi_api' | 'ruijie_api' = generate on-demand. */
  wifi_voucher_mode?: string | null;
  /** Ruijie Cloud network group ID (site identifier). Set only for ruijie_api locations. */
  ruijie_group_id?: number | null;
  /** Icon keys shown in the proposal PDF amenities strip. Defaults to ["wifi","coffee","printer","meeting"]. */
  proposal_amenity_icons?: string[];
  created_at: string;
  updated_at: string;
}

// ==========================================
// User Types
// ==========================================
export type UserRole = "admin" | "manager" | "sales_rep" | "floor_manager" | "accounts" | "fms" | "office_admin" | "it_manager" | "it_technician" | "viewer";

export interface User {
  id: string;
  auth_id: string;
  email: string;
  full_name: string;
  avatar_url?: string;
  phone?: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_login_at?: string;
}

// ==========================================
// Lead Types
// ==========================================
export type LeadStatus =
  | "new"
  | "contacted"
  | "tour_scheduled"
  | "tour_completed"
  | "proposal_sent"
  | "negotiating"
  | "won"
  | "lost"
  | "junk";

export type LeadSource =
  | "meta_ads"
  | "google_ads"
  | "direct_walkin"
  | "referral"
  | "cold_call"
  | "aggregator";

export type WorkspaceType =
  | "hot_desk"
  | "dedicated_desk"
  | "private_office"
  | "meeting_room"
  | "conference_room"
  | "virtual_office"
  | "managed"
  | "enterprise";

export type Rating = "none" | "hot" | "warm" | "cold";

export interface Lead {
  id: string;
  lead_number: number;
  first_name: string;
  last_name: string;
  company?: string;
  aggregator_contact_name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  website?: string;
  title?: string;
  secondary_email?: string;
  billing_emails?: string[];
  status: LeadStatus;
  source: LeadSource;
  industry?: string;
  no_of_employees?: number;
  rating: Rating;
  score: number;
  // Coworking-specific
  workspace_type?: WorkspaceType;
  seat_capacity?: number;
  preferred_location?: string;
  location_id?: string;
  location?: Location;
  working_hours?: string;
  budget_per_seat?: number;
  pan_number?: string;
  gst_number?: string;
  entity_type?: string | null;
  id_proof_path?: string | null;
  id_proof_uploaded_at?: string | null;
  // Followup flag (attached by API, not DB column)
  _followup?: { overdue: boolean; due_today: boolean; upcoming: boolean } | null;
  // Address
  street?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  country?: string;
  // Links
  enquiry_form_google?: string;
  enquiry_form_direct?: string;
  // Meta
  description?: string;
  tags: string[];
  assigned_to?: string;
  assigned_user?: User;
  created_by?: string;
  created_at: string;
  updated_at: string;
  converted_at?: string;
  lost_at?: string;
  lost_reason?: string;
  // Soft-disable
  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
}

// ==========================================
// Activity Types
// ==========================================
export type ActivityType = "call" | "meeting" | "note" | "email" | "tour";

export type CallOutcome =
  | "connected"
  | "no_answer"
  | "voicemail"
  | "busy"
  | "wrong_number"
  | "callback_scheduled";

export interface Activity {
  id: string;
  lead_id: string;
  type: ActivityType;
  subject?: string;
  description?: string;
  call_duration_seconds?: number;
  call_outcome?: CallOutcome;
  meeting_location?: string;
  meeting_start_at?: string;
  meeting_end_at?: string;
  follow_up_date?: string;
  follow_up_notes?: string;
  calendar_event_id?: string;
  followup_wa_reminder_sent_at?: string;
  is_follow_up_done: boolean;
  follow_up_actioned_by?: string;
  follow_up_actor?: User;
  follow_up_actioned_at?: string;
  created_by?: string;
  creator?: User;
  lead?: { first_name: string; last_name: string };
  created_at: string;
  updated_at: string;
  attendees?: MeetingAttendee[];
  minutes?: MeetingMinutes;
}

export interface MeetingAttendee {
  id: string;
  activity_id: string;
  user_id?: string;
  user?: User;
  external_name?: string;
  external_email?: string;
  is_external: boolean;
}

export interface MeetingMinutes {
  id: string;
  activity_id: string;
  agenda?: string;
  minutes_content: string;
  decisions?: string;
  action_items: ActionItem[];
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ActionItem {
  description: string;
  assignee_id?: string;
  due_date?: string;
  status: "pending" | "done";
}

// ==========================================
// Task Types
// ==========================================
export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  lead_id?: string;
  lead?: Lead;
  parent_task_id?: string;
  assigned_to?: string;
  assignee?: User;
  due_date?: string;
  completed_at?: string;
  tags: string[];
  subtasks?: Task[];
  created_by?: string;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Proposal Types
// ==========================================
export type ProposalStatus = "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired";

export interface LineItem {
  description: string;
  quantity: number;
  unit?: string;
  unit_price: number;
  total: number;
}

export interface ComplimentaryItem {
  name: string;
  unit: string;
  quantity: number; // free quota per month
  price_per_unit?: number; // rate for excess usage
  service_id?: string; // link to location_services master
}

export interface LocationService {
  id: string;
  location_id: string;
  name: string;
  unit: string;
  price_per_unit: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Proposal {
  id: string;
  lead_id: string;
  lead?: Lead;
  location_id?: string;
  location?: Location;
  proposal_number: string;
  title: string;
  status: ProposalStatus;
  description?: string;
  complimentary_items?: ComplimentaryItem[];
  items: LineItem[];
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  discount_percentage: number;
  discount_amount: number;
  total_amount: number;
  valid_until?: string;
  terms_and_conditions?: string;
  notes?: string;
  sent_at?: string;
  viewed_at?: string;
  accepted_at?: string;
  rejected_at?: string;
  rejection_reason?: string;
  pdf_storage_path?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  occupation_start_date?: string;
  // Date the pro-rata invoice was actually paid — enriched by GET
  // /api/proposals, null until paid. Prefers payment_received_at (the
  // generic-link/manual-record path that also gates contract activation),
  // falling back to the GST invoice's own billing_statements payment date.
  // Distinct from occupation_start_date, which is just the date proration
  // was calculated from.
  prorata_paid_date?: string | null;
  // Payment tracking (Razorpay)
  payment_status?: string; // "pending" | "paid"
  razorpay_payment_link_id?: string;
  razorpay_payment_link_url?: string;
  payment_received_at?: string;
  payment_amount?: number;
  payment_reference?: string;
  payment_medium?: string; // neft | rtgs | upi | cheque | cash | razorpay
  payment_screenshot_url?: string;
  payment_internal_notes?: string | null; // internal-only — never shown to the customer
  payment_recorded_by?: string; // user id of who manually recorded this payment
  payment_shortfall_approved_by?: string; // admin/manager who approved a ≤10% shortfall
  // Security deposit
  security_deposit_months?: number;
  security_deposit_amount?: number;
  deposit_payment_status?: string; // "not_required" | "pending" | "paid"
  // Set once a contract activation claims this proposal's collected deposit —
  // a proposal can spawn more than one contract, but the deposit belongs to
  // only one of them. See contracts/[id]/route.ts's activation snapshot.
  deposit_claimed_by_contract_id?: string | null;
  deposit_razorpay_link_id?: string;
  deposit_razorpay_link_url?: string;
  deposit_email_sent_at?: string;
  deposit_payment_received_at?: string;
  deposit_payment_amount?: number;
  deposit_payment_reference?: string;
  deposit_payment_medium?: string; // neft | rtgs | upi | cheque | razorpay | cash
  deposit_payment_screenshot_url?: string;
  deposit_payment_recorded_by?: string; // user id of who manually recorded this deposit payment
  deposit_payment_recorded_by_user?: { id: string; full_name: string } | null;
  deposit_shortfall_approved_by?: string; // user id of admin/manager who approved partial payment
  // Internal-only note for accounts (why this deposit request/collection exists) — never sent to the customer.
  deposit_internal_notes?: string | null;
  // Deposit credit — a deposit already held from a prior contract, netted
  // off the required deposit above. security_deposit_amount is never
  // changed by this; the balance to actually collect is
  // security_deposit_amount - deposit_credit_amount.
  deposit_credit_amount?: number;
  deposit_credit_reason?: string;
  deposit_credit_proof_url?: string;
  deposit_credit_applied_by?: string;
  deposit_credit_applied_at?: string;
  // Deposit exception — a signed override of the required deposit itself,
  // for one-off exceptions (positive raises it, negative lowers it).
  // security_deposit_amount is never changed by this; the effective
  // required deposit is security_deposit_amount + deposit_exception_amount.
  // Not to be confused with the unrelated deposit_adjustments table, which
  // draws the deposit down against a billing statement at settlement time.
  deposit_exception_amount?: number;
  deposit_exception_reason?: string;
  deposit_exception_proof_url?: string;
  deposit_exception_applied_by?: string;
  deposit_exception_applied_at?: string;
  // Accounting
  deposit_accounted?: boolean;
  deposit_accounted_at?: string;
  deposit_accounted_by?: string;
  // Deposit waiver OTP (zero-deposit approval)
  deposit_waiver_otp?: string;
  deposit_waiver_otp_expires?: string;
  deposit_waiver_verified_at?: string;
  deposit_waiver_verified_by?: string;
  deposit_waiver_verified_by_user?: { id: string; full_name: string } | null;
  deposit_waiver_requested_at?: string;
}

// ==========================================
// Invoice Types
// ==========================================
export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled";

export interface ProformaInvoice {
  id: string;
  lead_id?: string;
  lead?: Lead;
  proposal_id?: string;
  invoice_number: string;
  title: string;
  status: InvoiceStatus;
  items: LineItem[];
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  discount_percentage: number;
  discount_amount: number;
  total_amount: number;
  due_date?: string;
  paid_at?: string;
  payment_reference?: string;
  // Customer-facing — printed on the invoice PDF/email.
  notes?: string;
  // Internal-only — for accounts; never printed on the PDF or sent to the customer.
  internal_notes?: string | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
  // Razorpay payment link (auto-created when emailing)
  razorpay_link_id?: string;
  razorpay_link_url?: string;
  // GST invoice (sent automatically once payment is confirmed)
  gst_invoice_number?: string;
  gst_invoice_sent_at?: string;
  gst_invoice_sent_to?: string;
  // Accounting head (receivables classification)
  primary_head?: string | null;
  // Accounting
  accounted?: boolean;
  accounted_at?: string;
  accounted_by?: string;
  // Contract attribution — set when this ad-hoc invoice bills a contract charge
  // collected outside the normal statement flow. See migration 00426.
  contract_id?: string | null;
  contract?: Contract;
  attribution_purpose?: "prorata_first_invoice" | "monthly_rent" | "other" | null;
  attributed_at?: string | null;
  attributed_by?: string | null;
}

// ==========================================
// Document Types
// ==========================================
export interface DocumentFolder {
  id: string;
  name: string;
  parent_folder_id?: string;
  children?: DocumentFolder[];
  created_by?: string;
  created_at: string;
}

export interface CrmDocument {
  id: string;
  title: string;
  description?: string;
  file_name: string;
  file_path: string;
  mime_type: string;
  size_bytes: number;
  folder_id?: string;
  category?: string;
  tags: string[];
  version: number;
  parent_document_id?: string;
  uploaded_by?: string;
  uploader?: User;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Contract Types
// ==========================================
export type ContractStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "rejected"
  | "active"
  | "renewal_in_progress"
  | "renewed"
  | "expired"
  | "terminated";

export type BillingCycle =
  | "monthly"
  | "quarterly"
  | "half_yearly"
  | "yearly";

export interface ContractAddon {
  id: string;
  contract_id: string;
  description: string;
  amount: number;
  effective_from: string;
  effective_until?: string | null;
  is_active: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contract {
  id: string;
  contract_number: string;
  lead_id: string;
  lead?: Lead;
  proposal_id?: string;
  proposal?: Proposal;
  location_id?: string;
  location?: Location;
  title: string;
  status: ContractStatus;
  items: LineItem[];
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  discount_percentage: number;
  discount_amount: number;
  total_amount: number;
  billing_cycle: BillingCycle;
  /** Controls whether monthly cycle issues PI first (default) or GST invoice directly. */
  billing_mode?: 'proforma_first' | 'gst_direct';
  tenure_months: number;
  start_date: string;
  end_date: string;
  next_billing_date?: string;
  /** Cumulative days added via contract extension (lifetime cap: 60). */
  days_extended?: number;
  seats: number;
  // Printer-side ID assigned to this customer at the location.
  // Used to map the customer to rows in the monthly print-server report.
  // Unique per location (NULL allowed; multiple NULLs OK).
  department_id?: string | null;
  terms_and_conditions?: string;
  notes?: string;
  // Membership agreement fields
  workspace_description?: string;
  parking_space?: string;
  complimentary_services?: string;
  security_deposit_months?: number;
  escalation_percentage?: number;
  notice_period_months?: number;
  lock_in_months?: number | null;
  member_signatory_name?: string;
  member_signatory_designation?: string;
  /** The signatory's personal ID number — may be PAN or Aadhaar depending on member_signatory_id_type */
  member_signatory_pan?: string;
  /** Type of personal ID provided: 'pan' (default) or 'aadhaar' */
  member_signatory_id_type?: 'pan' | 'aadhaar';
  agreement_date?: string;
  // Leegality e-signing
  leegality_document_id?: string;
  leegality_sign_url?: string;       // Lessor (TWV/Naval) signing URL
  leegality_lessee_sign_url?: string; // Lessee (customer) signing URL
  leegality_status?: string;
  signed_at?: string;
  // Status timestamps
  sent_at?: string;
  viewed_at?: string;
  accepted_at?: string;
  rejected_at?: string;
  activated_at?: string;
  renewed_at?: string;
  terminated_at?: string;
  termination_reason?: string;
  // Lifecycle actors (user IDs)
  sent_by?: string | null;
  viewed_by?: string | null;
  accepted_by?: string | null;
  rejected_by?: string | null;
  activated_by?: string | null;
  terminated_by?: string | null;
  renewed_by?: string | null;
  // Lifecycle actor names (resolved by GET /api/contracts/[id])
  created_by_name?: string | null;
  sent_by_name?: string | null;
  viewed_by_name?: string | null;
  accepted_by_name?: string | null;
  rejected_by_name?: string | null;
  activated_by_name?: string | null;
  terminated_by_name?: string | null;
  renewed_by_name?: string | null;
  signed_document_id?: string;
  signed_document?: CrmDocument;
  stamp_reference?: string | null;
  printer_department_id?: string;
  // Renewal chain
  parent_contract_id?: string | null;
  parent_contract?: { id: string; contract_number: string } | null;
  is_renewal?: boolean;
  renewal_sequence?: number;
  // Escalation waiver
  escalation_waived?: boolean;
  escalation_waiver_reason?: string | null;
  escalation_waived_by?: string | null;
  // Escalation approval
  escalation_approval_status?: string | null; // 'pending' | 'approved' | 'rejected'
  escalation_approval_id?: string | null;
  // Deposit carry-forward
  deposit_carried_from?: string | null;
  deposit_shortfall?: number;
  // Deposit ledger — owned by the contract from activation onward (snapshotted
  // from the linked proposal at that moment; see contracts/[id]/route.ts).
  // The proposal only bridges the commercial gap until activation — once
  // active, top-ups/adjustments/corrections all read and write these fields,
  // never the proposal's. Mirrors the equivalent fields on Proposal below.
  security_deposit_amount?: number;
  deposit_payment_status?: string; // "not_required" | "pending" | "paid"
  deposit_payment_amount?: number;
  deposit_payment_reference?: string;
  deposit_payment_medium?: string; // neft | rtgs | upi | cheque | razorpay | cash
  deposit_payment_received_at?: string;
  deposit_internal_notes?: string | null;
  // Deposit refund — set when money has actually gone back to the customer.
  // Excluded from the pooled balance (see get_deposit_available_balance);
  // no UI writes these yet, they're a manual accounts lever for now.
  deposit_refunded_amount?: number | null;
  deposit_refunded_at?: string | null;
  deposit_refund_reference?: string | null;
  // Renewal communication
  renewal_reminder_sent_at?: string | null;
  renewal_reminder_count?: number;
  // Decline tracking
  renewal_declined?: boolean;
  renewal_declined_reason?: string | null;
  renewal_declined_at?: string | null;
  renewal_declined_by?: string | null;
  // Pro-rata collection for mid-month renewals
  prorata_billing_statement_id?: string | null;
  prorata_payment_status?: "not_applicable" | "pending" | "paid" | "waived";
  created_by?: string;
  created_at: string;
  updated_at: string;
  // Electricity sub-billing overrides (stores overrides only; falls back to location config)
  electricity_settings?: ContractElectricitySettings | null;
  // Tiered rate phases
  phase_start_date?: string | null;
  rate_phases?: ContractRatePhase[];
  // start_date is a placeholder until the linked proposal's pro-rata invoice
  // is paid — see supabase/migrations/00503_contract_start_date_confirmation.sql
  start_date_confirmed?: boolean;
  start_date_locked_at?: string | null;
}

export interface ContractRatePhase {
  id: string;
  contract_id: string;
  phase_order: number;
  duration_months: number;
  monthly_rate: number;
  /** Explicit day-precise end date, overriding the default calendar-month-bucket boundary. */
  end_date?: string | null;
  created_at: string;
}

export interface BillingPayment {
  id: string;
  billing_statement_id: string;
  amount: number;
  payment_date: string;
  payment_mode: string;
  payment_reference?: string;
  razorpay_payment_id?: string;
  proof_path?: string;
  notes?: string;
  recorded_by?: string;
  created_at: string;
}

// ==========================================
// Deposit Adjustment Types
// ==========================================
export type DepositAdjustmentStatus = "pending_approval" | "approved" | "rejected" | "reversed";

export interface DepositAdjustment {
  id: string;
  contract_id: string;
  // Informational/back-compat only since the pooled-customer-deposits migration —
  // the balance math keys off source_lead_id now, neither of these is read.
  source_contract_id: string;
  source_proposal_id?: string | null;
  source_lead_id: string;
  billing_statement_id: string;
  billing_payment_id?: string | null;
  amount: number;
  status: DepositAdjustmentStatus;
  requested_by: string;
  requested_at: string;
  approved_by?: string | null;
  approved_at?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  rejection_reason?: string | null;
  reversed_by?: string | null;
  reversed_at?: string | null;
  reversal_reason?: string | null;
  notify_customer: boolean;
  customer_notified_at?: string | null;
  accounts_notified_at?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  // Joined display fields (populated by API routes, not stored)
  requested_by_name?: string;
  approved_by_name?: string;
  rejected_by_name?: string;
  reversed_by_name?: string;
}

/** Why `available` is 0 — drives the greyed-out explanation on the
 *  "Adjustment against deposit" option. NULL when there is a balance. */
export type DepositUnavailableReason =
  | "no_proposal"
  | "deposit_pending"
  | "no_deposit"
  | "fully_committed";

export interface DepositBalance {
  // Chain root of the CALLING contract — informational/back-compat only
  // since the pooled-customer-deposits migration. The figures below are
  // pooled across every contract of source_lead_id, not this chain.
  source_contract_id: string;
  source_proposal_id: string | null;
  source_lead_id: string;
  deposit_collected: number;
  committed: number;
  available: number;
  unavailable_reason: DepositUnavailableReason | null;
}

export type DepositTopupStatus = "pending" | "paid" | "reversed" | "cancelled";
export type DepositTopupCategory = "seat_expansion" | "risk_buffer" | "customer_requested" | "renewal_escalation" | "other";
export type DepositTopupCollectionMethod = "razorpay_link" | "manual";

export interface DepositTopup {
  id: string;
  contract_id: string;
  // Informational/back-compat only since the pooled-customer-deposits migration —
  // the balance math keys off source_lead_id now, neither of these is read.
  source_contract_id: string;
  source_proposal_id?: string | null;
  source_lead_id: string;
  amount: number;
  category: DepositTopupCategory;
  category_note?: string | null;
  status: DepositTopupStatus;
  collection_method: DepositTopupCollectionMethod;
  razorpay_payment_link_id?: string | null;
  razorpay_payment_link_url?: string | null;
  payment_mode?: string | null;
  payment_reference?: string | null;
  proof_path?: string | null;
  applies_to_shortfall: boolean;
  created_by: string;
  created_at: string;
  paid_at?: string | null;
  reversed_by?: string | null;
  reversed_at?: string | null;
  reversal_reason?: string | null;
  cancelled_by?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  accounted: boolean;
  accounted_at?: string | null;
  accounted_by?: string | null;
  accounted_proof_path?: string | null;
  updated_at: string;
  // Joined display fields (populated by API routes, not stored)
  created_by_name?: string;
  reversed_by_name?: string;
  cancelled_by_name?: string;
  accounted_by_name?: string;
}

/** A row in the Tally Inbox "Deposits" accounting tab — unifies original
 * proposal-stage security deposits and later top-ups into one worklist. */
export interface DepositInboxRow {
  id: string;
  kind: "deposit" | "topup";
  /** Open query thread count — drives the "Query" button badge. Set by
   *  /api/accounting/inbox/deposits; see src/lib/queries/registry.ts. */
  open_query_count?: number;
  party_name: string;
  contract_number?: string | null;
  proposal_number?: string | null;
  category?: DepositTopupCategory | null;
  /** Null for legacy proposals where the payment amount was never recorded — show as "not on file", never as ₹0. */
  amount: number | null;
  /** The deposit the contract called for. Used as a labelled fallback when `amount` was never recorded. */
  expected_amount?: number | null;
  /** A credit already held from a prior contract, netted off the required deposit. */
  credit_amount?: number | null;
  credit_reason?: string | null;
  /** A signed exception override of the required deposit (positive raises it, negative lowers it). */
  exception_amount?: number | null;
  exception_reason?: string | null;
  payment_reference?: string | null;
  payment_medium?: string | null;
  /** Null for legacy proposals where the received date was never recorded. */
  paid_at: string | null;
  accounted: boolean;
  accounted_at?: string | null;
  accounted_by_name?: string | null;
  /** The Tally receipt attached when this was accounted. */
  proof_path?: string | null;
  /** How the money came in — drives which verification details the inbox shows. */
  collection_method?: "razorpay" | "manual" | null;
  /** Customer-supplied payment proof captured at collection time (manual mode). */
  payment_proof_url?: string | null;
  razorpay_link_id?: string | null;
  razorpay_link_url?: string | null;
  /** When the money actually reached the bank, per Razorpay's settlement recon. */
  settled_at?: string | null;
  settlement_id?: string | null;
  /** Internal-only accounts note — proposals.deposit_internal_notes or deposit_topups.category_note. */
  internal_note?: string | null;
}

export const DEPOSIT_TOPUP_CATEGORY_LABELS: Record<DepositTopupCategory, string> = {
  seat_expansion: "Seat / space expansion",
  risk_buffer: "Risk buffer",
  customer_requested: "Customer requested",
  renewal_escalation: "Renewal escalation shortfall",
  other: "Other",
};

// ==========================================
// Voucher Types
// ==========================================
export type VoucherStatus = "available" | "issued" | "expired" | "revoked";

export interface VoucherRepository {
  id: string;
  voucher_code: string;
  status: VoucherStatus;
  validity_days?: number;
  location_id?: string;
  location?: Location;
  metadata: Record<string, unknown>;
  uploaded_by?: string;
  uploaded_at: string;
  issued_at?: string;
  expires_at?: string;
}

export type VoucherStockLevel = "green" | "amber" | "red";

export interface VoucherInventoryGroup {
  validity_days: number | null;
  label: string;
  /** Location the pool belongs to. Each location runs its own voucher
   *  inventory, so a single (validity_days) summary across locations is
   *  misleading — cards key on (location_id, validity_days). */
  location_id?: string | null;
  location_name?: string | null;
  location_code?: string | null;
  available: number;
  issued: number;
  total: number;
  stock_level: VoucherStockLevel;
}

export interface VoucherIssuance {
  id: string;
  contract_id?: string;
  voucher_id: string;
  booking_id?: string;
  voucher?: VoucherRepository;
  lead_id: string;
  seat_number: number;
  issued_by?: string;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  revoked_at?: string;
  revoke_reason?: string;
  // Per-seat email tracking
  seat_occupant_email?: string;
  emailed_at?: string;
  is_active: boolean;
  replaces_issuance_id?: string;
  /** UniFi internal _id — set when issued via Unifi live API. Used for revocation. */
  unifi_voucher_id?: string | null;
}

export interface AdminOtp {
  id: string;
  otp_code: string;
  purpose: string;
  reference_id: string;
  requested_by: string;
  verified_at?: string;
  expires_at: string;
  is_used: boolean;
  attempts: number;
  created_at: string;
}

// ==========================================
// Usage Charge & Billing Types
// ==========================================
export type UsageChargeStatus = "pending" | "billed" | "waived";
export type BillingStatementStatus = "draft" | "finalized" | "exported" | "voided";

export interface UsageCharge {
  id: string;
  contract_id: string;
  lead_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  charge_date: string;
  status: UsageChargeStatus;
  billing_statement_id?: string;
  notes?: string;
  proof_path?: string;
  settled_in_booking_id?: string;
  settled_at?: string;
  waived_by?: string;
  waived_at?: string;
  waive_reason?: string;
  booking?: { booking_number: string; booking_date: string };
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface BillingStatement {
  id: string;
  statement_number: string;
  contract_id: string;
  contract?: Contract;
  lead_id: string;
  lead?: Lead;
  // Virtual Office owners — set instead of contract_id for VO statements.
  // case_id: per-case invoice (prepaid aggregator / direct client).
  // aggregator_id: postpaid consolidated invoice (many cases bundled).
  case_id?: string | null;
  case?: VoCase;
  aggregator_id?: string | null;
  aggregator?: Aggregator;
  period_start: string;
  period_end: string;
  fixed_amount: number;
  usage_amount: number;
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  total_amount: number;
  status: BillingStatementStatus;
  usage_charges?: UsageCharge[];
  finalized_at?: string;
  exported_at?: string;
  notes?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  // GST invoice fields (auto-billing)
  gst_invoice_number?: string;
  gst_invoice_path?: string;
  cgst_amount?: number;
  sgst_amount?: number;
  igst_amount?: number;
  is_interstate?: boolean;
  hsn_sac_code?: string;
  buyer_gstin?: string;
  place_of_supply?: string;
  razorpay_payment_link_id?: string;
  razorpay_payment_link_url?: string;
  emailed_at?: string;
  emailed_to?: string;
  payment_status?: string; // "unpaid" | "partially_paid" | "paid"
  billing_payments?: BillingPayment[];
  // Accounting head (receivables classification)
  primary_head?: string | null;
  // Auto-proforma split: 'combined' (legacy), 'rent' (auto-dispatched), 'usage' (admin review),
  // 'reimbursement' (manually billed from an approved reimbursement purchase_request)
  statement_type?: 'combined' | 'rent' | 'usage' | 'electricity' | 'reimbursement' | 'vo_renewal' | 'vo_case' | 'vo_aggregator_consolidated' | null;
  // Set when statement_type === 'reimbursement' — traces back to the purchase_request it was billed from
  source_pr_id?: string | null;
  // Proforma tracking
  proforma_sent_at?: string | null;
  proforma_sent_by?: string | null;
  proforma_viewed_at?: string | null;
  gst_invoice_viewed_at?: string | null;
  // Usage amounts split (set by generators)
  service_usage_amount?: number;
  booking_usage_amount?: number;
  // PI → early GST override fields
  pi_cancelled_at?: string | null;
  pi_cancelled_by?: string | null;
  pi_override_reason?: string | null;
  gst_invoice_due_date?: string | null;
  due_date?: string | null;
  // Voided statement tracking
  voided_at?: string | null;
  voided_by?: string | null;
  void_reason?: string | null;
  voided_statement_id?: string | null;
  // Reminder tracking
  reminder_count?: number;
  last_reminder_sent_at?: string | null;
}

// ==========================================
// Audit Log Types
// ==========================================
export type AuditAction = "create" | "update" | "delete" | "login" | "email_sent" | "direct_future_contract" | "disable" | "enable" | "cheque_signed" | "view" | "moratorium_requested" | "moratorium_approved" | "moratorium_rejected" | "moratorium_applied" | "moratorium_overridden" | "deposit_adjustment_requested" | "deposit_adjustment_approved" | "deposit_adjustment_rejected" | "deposit_adjustment_reversed" | "deposit_topup_recorded" | "deposit_topup_link_created" | "deposit_topup_paid" | "deposit_topup_reversed" | "deposit_topup_cancelled" | "deposit_accounted" | "deposit_accounting_reopened" | "asset_scope_mismatch" | "payment_fields_changed" | "contract_extended" | "query_raised" | "query_resolved" | "query_reopened" | "query_retargeted" | "payment_reported" | "payment_report_verified" | "payment_report_rejected" | "invoice_attributed" | "invoice_attribution_cleared" | "cap_override" | "revoke" | "replace";
export type AuditEntityType =
  | "lead"
  | "activity"
  | "task"
  | "proposal"
  | "invoice"
  | "document"
  | "user"
  | "contract"
  | "voucher"
  | "usage_charge"
  | "billing_statement"
  | "space"
  | "booking"
  | "booking_payment"
  | "booking_credit"
  | "lead_caution"
  | "refund_request"
  | "app_setting"
  | "contract_facility"
  | "accounting_period"
  | "facility_usage_record"
  | "contract_payment"
  | "aggregator"
  | "case"
  | "case_document"
  | "case_agreement"
  | "aggregator_invoice"
  | "procurement_vendor"
  | "procurement_item"
  | "purchase_request"
  | "purchase_order"
  | "vendor_bill"
  | "pc_request"
  | "pc_entry"
  | "support_ticket"
  | "prepaid_package"
  | "location"
  | "stock_transfer"
  | "consumption_log"
  | "beverage_log"
  | "location_floor"
  | "space_unit"
  | "contract_space_allocation"
  | "space_seat_occupant"
  | "facility_asset_category"
  | "facility_asset"
  | "facility_issue"
  | "facility_issue_attachment"
  | "facility_department"
  | "facility_department_member"
  | "booking_addon"
  | "addon_catalog"
  | "service_catalog"
  | "contract_service_quota"
  | "proposal_service_quota"
  | "service_usage_record"
  | "service_usage_import"
  | "location_print_template"
  | "approval_request"
  | "landlord"
  | "property_lease"
  | "lease_payment"
  | "lease_escalation"
  | "lease_asset"
  | "lease_handover"
  | "lease_document"
  | "lease_service_offering"
  | "cosec_access_user"
  | "cosec_device"
  | "employee"
  | "salary_definition"
  | "leave_request"
  | "leave_policy"
  | "payroll_run"
  | "payroll_slip"
  | "unifi_voucher"
  | "electricity_bill"
  | "electricity_billing_profile"
  | "location_electricity_config"
  | "asset_document"
  | "contract_billing_moratorium"
  | "user_location"
  | "transfer_billing_policy"
  | "unifi_device_label"
  | "unifi_ap_alert"
  | "deposit_adjustment"
  | "deposit_topup"
  | "recurring_bill_rule";

export interface AuditLog {
  id: string;
  entity_type: AuditEntityType;
  entity_id: string;
  action: AuditAction;
  changes: Record<string, { old: unknown; new: unknown }>;
  performed_by?: string;
  performer?: User;
  created_at: string;
}

// ==========================================
// Communications Log Types
// ==========================================
export type CommunicationEntityType = "billing_statement" | "contract" | "proposal" | "booking" | "lead";
export type CommunicationChannel = "email" | "whatsapp" | "sms";
export type CommunicationStatus = "sent" | "failed";

/** A single outbound email/WhatsApp/SMS send, with full content + attachment
 *  reference — powers the post-send confirmation dialog, the inline
 *  "Recent communications" card on record pages, and the lead activity
 *  timeline. All three render the same row via <CommunicationLogRow>. */
export interface CommunicationLogEntry {
  id: string;
  entity_type: CommunicationEntityType;
  entity_id: string;
  channel: CommunicationChannel;
  recipient: string;
  subject: string | null;
  body: string;
  attachment_url: string | null;
  attachment_name: string | null;
  status: CommunicationStatus;
  error_message: string | null;
  sent_by: string | null;
  created_at: string;
}

// ==========================================
// Space Types
// ==========================================
export interface SpaceOperatingDay {
  open: string;
  close: string;
  is_open: boolean;
}

export type SpaceOperatingHours = Record<string, SpaceOperatingDay>;

export type SpacePricingModel = "hourly" | "daily";

export interface Space {
  id: string;
  name: string;
  location_id: string;
  location?: Location;
  capacity: number;
  // Pricing model determines which rate applies:
  //  - hourly: hourly_rate × duration_hours
  //  - daily:  daily_rate × 1 (booking covers the centre's operating hours for that day)
  pricing_model: SpacePricingModel;
  hourly_rate: number;          // 0 for daily-priced spaces
  daily_rate?: number | null;   // set when pricing_model = 'daily'
  description?: string;
  workspace_type?: WorkspaceType;
  operating_hours: SpaceOperatingHours;
  max_advance_booking_days: number;
  min_booking_minutes: number;
  min_booking_minutes_contract?: number; // conference_room/meeting_room only — contract-holder minimum
  cancellation_policy?: string;
  no_show_grace_minutes: number;
  is_active: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
  facilities?: SpaceFacility[];
}

export interface SpaceFacility {
  id: string;
  space_id: string;
  name: string;
  is_complimentary: boolean;
  charge_per_use: number;
  is_available: boolean;
  created_at: string;
}

// ==========================================
// Booking Types
// ==========================================
export type BookingStatus = "confirmed" | "checked_in" | "checked_out" | "cancelled" | "no_show";
export type BookingCustomerType = "contract_holder" | "walk_in" | "guest";
export type BookingPaymentStatus = "pending" | "paid" | "waived" | "posted_to_bill" | "prepaid";

export type BookingRefundStatus = "requested" | "approved" | "processed";

export interface Booking {
  id: string;
  booking_number: string;
  space_id: string;
  space?: Space;
  location_id: string;
  location?: Location;
  booking_date: string;
  start_time: string;
  end_time: string;
  duration_hours: number;
  // Pricing snapshot at booking time
  pricing_model?: SpacePricingModel;
  unit_rate?: number | null;        // per-unit rate (per-hour or per-day)
  quantity?: number | null;         // hours for hourly, days (always 1) for daily
  customer_type: BookingCustomerType;
  contract_id?: string;
  contract?: Contract;
  lead_id?: string;
  lead?: Lead;
  booker_phone?: string;
  guest_name?: string;
  guest_email?: string;
  guest_phone?: string;
  guest_company?: string;
  hourly_rate: number;
  total_amount: number;
  gst_rate?: number;
  gst_amount?: number;
  total_amount_with_gst?: number;
  payment_status: BookingPaymentStatus;
  payment_mode?: string;
  payment_reference?: string;
  status: BookingStatus;
  check_in_at?: string;
  check_out_at?: string;
  checked_in_by?: string;
  checked_out_by?: string;
  usage_charge_id?: string;
  refund_status?: BookingRefundStatus;
  refund_amount?: number;
  refund_reason?: string;
  refund_approved_by?: string;
  refund_approved_at?: string;
  // Recurring booking
  series_id?: string;
  series?: RecurringBookingSeries;
  // Reschedule tracking
  rescheduled_from_id?: string;
  reschedule_count: number;
  original_booking_date?: string;
  original_start_time?: string;
  original_end_time?: string;
  // Tokens for public pages
  feedback_token?: string;
  payment_token?: string;
  // No-show detection
  no_show_detected_at?: string;
  // Complimentary booking — set when payment_status='waived' AND
  // the booking was zero-rupees (comp). Picklist value + optional
  // staff details for analytics + audit trail.
  complimentary_reason?: BookingComplimentaryReason | null;
  complimentary_details?: string | null;
  // Razorpay Payment Links
  razorpay_payment_link_id?: string;
  razorpay_payment_link_url?: string;
  // Prepaid package redemption
  prepaid_purchase_id?: string;
  prepaid_credits_used?: number;
  prepaid_topup_amount?: number;
  notes?: string;
  aggregator_booking_id?: string;
  // Number of attendees collected at booking time — used to determine how
  // many WiFi vouchers to issue (1 voucher supports 2 device logins).
  num_attendees?: number | null;
  loi_number?: string | null;
  purpose?: string | null;
  access_provided_by?: string | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
  cancelled_by?: string;
  facilities?: BookingFacility[];
  feedback?: BookingFeedback | null;          // staff rating (backward compat)
  customer_feedback?: BookingFeedback | null; // customer-submitted via link
  // Resolved actor names (populated by GET /api/bookings/[id])
  created_by_name?: string | null;
  checked_in_by_name?: string | null;
  checked_out_by_name?: string | null;
  cancelled_by_name?: string | null;
  // Quota info for contract-holder bookings with free quota
  quota_info?: {
    monthly_quota: number;
    used_this_month: number;
    remaining_after: number;
  } | null;
}

export interface BookingFacility {
  id: string;
  booking_id: string;
  facility_name: string;
  is_complimentary: boolean;
  charge: number;
  created_at: string;
}

// ==========================================
// Booking Feedback Types
// ==========================================
export interface BookingFeedback {
  id: string;
  booking_id: string;
  lead_id: string;
  source: "staff" | "customer";
  space_etiquette: number | null;
  payment_discipline: number | null;
  community_behavior: number | null;
  guest_management: number | null;
  resource_usage: number | null;
  renewal_likelihood: number | null;
  overall_rating: number | null;
  notes?: string;
  rated_by?: string;
  rater?: User;
  booking?: Booking;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Booking Payment Types (multi-payment per booking)
// ==========================================
export type BookingPaymentMode = "cash" | "upi" | "card" | "razorpay";
export type BookingPaymentRecordStatus = "pending" | "verified" | "rejected";

export interface BookingPayment {
  id: string;
  booking_id: string;
  amount: number;
  payment_mode: BookingPaymentMode;
  payment_reference?: string;
  screenshot_path?: string;
  screenshot_verified?: boolean | null;
  verification_notes?: string;
  status: BookingPaymentRecordStatus;
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
  razorpay_signature?: string;
  created_by?: string;
  creator?: { id: string; full_name: string };
  // Cash-handover trail — populated for cash payments. Lets the UI
  // show "Collected by Ashok · pending handover" / "Handed over to
  // Priya · confirmed by Rahul" without a second round-trip.
  cash_handover_status?: "pending_handover" | "handed_over" | null;
  collected_by?: string | null;
  collected_at?: string | null;
  collector?: { id: string; full_name: string } | null;
  handed_over_to?: string | null;
  handed_over_at?: string | null;
  handover_receiver?: { id: string; full_name: string } | null;
  handover_confirmed_by?: string | null;
  handover_confirmed_at?: string | null;
  handover_confirmer?: { id: string; full_name: string } | null;
  handover_notes?: string | null;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Booking Credits — partial-checkout carry-forward
// ==========================================
export type BookingCreditStatus = "active" | "exhausted" | "expired" | "revoked";

export interface BookingCredit {
  id: string;
  phone: string;
  location_id: string;
  lead_id?: string | null;
  hours_total: number;
  hours_used: number;
  hourly_rate_snapshot: number;
  issued_from_booking_id?: string | null;
  issued_at: string;
  expires_at: string;
  status: BookingCreditStatus;
  notes?: string | null;
  issued_by?: string | null;
  revoked_by?: string | null;
  revoked_at?: string | null;
  created_at: string;
  updated_at: string;
  // Optional joined fields when the API selects them
  location?: { id: string; name: string; code: string } | null;
  lead?: { id: string; first_name: string; last_name: string; company?: string | null } | null;
  issued_from_booking?: { id: string; booking_number: string } | null;
}

// ==========================================
// Cancellation flow — reasons, lead cautions, refund requests
// ==========================================

export type BookingComplimentaryReason =
  | "manager_goodwill"
  | "aggregator_demo"
  | "staff_use"
  | "event_partnership"
  | "other";

export type BookingCancellationReason =
  | "customer_requested"
  | "no_show"
  | "overbooking_error"
  | "suspected_fake_booking"
  | "centre_operational_issue"
  | "other";

export type LeadCautionSeverity = "info" | "warning" | "danger";

export interface LeadCaution {
  id: string;
  lead_id: string;
  booking_id?: string | null;
  note: string;
  severity: LeadCautionSeverity;
  is_active: boolean;
  created_by?: string | null;
  dismissed_by?: string | null;
  dismissed_at?: string | null;
  created_at: string;
  updated_at: string;
  // Joined when fetched via API
  creator?: { id: string; full_name: string } | null;
  booking?: { id: string; booking_number: string } | null;
}

export type RefundRequestReason =
  | "centre_at_fault"
  | "within_policy_window"
  | "goodwill"
  | "other";

export type RefundRequestStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "processed";

export interface RefundRequest {
  id: string;
  booking_id: string;
  amount_requested: number;
  reason: string; // RefundRequestReason — text column for forward compat
  details?: string | null;
  status: RefundRequestStatus;
  requested_by: string;
  requested_at: string;
  approved_by?: string | null;
  approved_at?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  rejected_reason?: string | null;
  processed_by?: string | null;
  processed_at?: string | null;
  refund_method?: string | null;
  refund_reference?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields — populated on the GET endpoint
  booking?: {
    id: string;
    booking_number: string;
    booking_date: string;
    total_amount: number;
    total_amount_with_gst?: number;
    customer_type?: string;
    guest_name?: string | null;
    location?: { id: string; name: string; code: string } | null;
    lead?: { id: string; first_name: string; last_name: string; company?: string | null } | null;
  } | null;
  requester?: { id: string; full_name: string } | null;
  approver?: { id: string; full_name: string } | null;
  rejector?: { id: string; full_name: string } | null;
  processor?: { id: string; full_name: string } | null;
}

// ==========================================
// App Settings Types
// ==========================================
export interface AppSetting {
  id: string;
  key: string;
  value: string;
  is_encrypted: boolean;
  updated_by?: string;
  created_at: string;
  updated_at: string;
}

// ==========================================
// API Response Types
// ==========================================
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ==========================================
// Dashboard Types
// ==========================================
export interface DashboardNote {
  id: string;
  lead_id: string;
  subject?: string;
  created_at: string;
  lead?: { first_name: string; last_name: string };
}

export interface DashboardStats {
  pipeline: { status: LeadStatus; count: number }[];
  tasks_due_today: number;
  tasks_overdue: number;
  recent_activities: Activity[];
  recent_notes: DashboardNote[];
  conversion: {
    total_leads: number;
    won: number;
    lost: number;
    rate: number;
    /** This-month cohort: of leads created since the 1st of this month, how
     *  many have already converted. Real-time pulse alongside the since-launch
     *  cumulative number. */
    this_month?: { total: number; won: number; rate: number };
  };
  pending_follow_ups: number;
}

// ==========================================
// Accounting Module Types
// ==========================================
export type AccountingPeriodStatus = "open" | "locked";
export type CashHandoverStatus = "pending_handover" | "handed_over";
export type ContractPaymentMode = "cash" | "upi" | "card" | "bank_transfer" | "razorpay";
export type ContractPaymentStatus = "pending" | "verified" | "rejected";
export type GstInvoiceStatus = "invoiced" | "sent";

export interface ContractFacility {
  id: string;
  contract_id: string;
  name: string;
  unit: string;
  cost_per_unit: number;
  free_quota: number;
  is_active: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface AccountingPeriod {
  id: string;
  year: number;
  month: number;
  status: AccountingPeriodStatus;
  locked_at?: string;
  locked_by?: string;
  locker?: User;
  unlocked_at?: string;
  unlocked_by?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface FacilityUsageRecord {
  id: string;
  accounting_period_id: string;
  contract_id: string;
  contract_facility_id: string;
  contract_facility?: ContractFacility;
  quantity_used: number;
  free_quota_applied: number;
  billable_quantity: number;
  unit_price: number;
  total_charge: number;
  notes?: string;
  is_template?: boolean; // true when auto-populated from previous month (not yet saved)
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ContractPayment {
  id: string;
  payment_number: string;
  contract_id: string;
  contract?: Contract;
  accounting_period_id?: string;
  amount: number;
  payment_mode: ContractPaymentMode;
  payment_reference?: string;
  screenshot_path?: string;
  screenshot_verified?: boolean | null;
  status: ContractPaymentStatus;
  payment_date: string;
  gst_invoice_number?: string;
  gst_invoice_path?: string;
  gst_invoice_status?: GstInvoiceStatus | null;
  gst_invoice_sent_at?: string;
  gst_invoice_sent_to?: string;
  reminder_sent_at?: string;
  cash_handover_status?: CashHandoverStatus | null;
  collected_by?: string;
  collector?: User;
  collected_at?: string;
  handed_over_to?: string;
  handed_over_at?: string;
  handover_confirmed_by?: string;
  handover_confirmed_at?: string;
  handover_notes?: string;
  notes?: string;
  // Accounting head — which revenue category this payment settled
  allocated_head?: string | null;
  created_by?: string;
  creator?: User;
  created_at: string;
  updated_at: string;
}

export interface AgingBucket {
  label: string;
  days_range: string;
  count: number;
  total_amount: number;
  contract_ids: string[];
}

export interface ContractAccountingSummary {
  contract: Contract;
  recurring_amount: number;
  carried_forward_balance: number;
  facility_usage_total: number;
  facility_usages: FacilityUsageRecord[];
  adhoc_charges_total: number;
  adhoc_charges: UsageCharge[];
  booking_charges_total: number;
  bookings: Booking[];
  payments_total: number;
  payments: ContractPayment[];
  gst_invoice_number?: string;
  gst_invoice_status?: GstInvoiceStatus | null;
  gst_invoice_path?: string;
  gst_invoice_sent_at?: string;
  current_month_total: number;
  total_owed: number;
}

export interface MonthlyAccountingSummary {
  period: AccountingPeriod;
  contracts: ContractAccountingSummary[];
  walkin_bookings: {
    booking: Booking;
    payments: BookingPayment[];
  }[];
  cash_collections: {
    pending: (ContractPayment | BookingPayment)[];
    handed_over: (ContractPayment | BookingPayment)[];
  };
  aging_buckets: AgingBucket[];
  totals: {
    total_billable: number;
    total_collected: number;
    total_outstanding: number;
    total_cash_pending_handover: number;
    total_carried_forward: number;
  };
}

// ==========================================
// Recurring Booking Series
// ==========================================
export type RecurringFrequency = "daily" | "weekly" | "biweekly" | "monthly";

export interface RecurringBookingSeries {
  id: string;
  space_id: string;
  space?: Space;
  location_id: string;
  location?: Location;
  customer_type: BookingCustomerType;
  contract_id?: string;
  contract?: Contract;
  lead_id?: string;
  lead?: Lead;
  guest_name?: string;
  guest_phone?: string;
  guest_email?: string;
  guest_company?: string;
  booker_phone?: string;
  start_time: string;
  end_time: string;
  duration_hours: number;
  frequency: RecurringFrequency;
  day_of_week?: number;
  day_of_month?: number;
  series_start: string;
  series_end: string;
  facility_ids?: string[];
  notes?: string;
  is_active: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
  bookings?: Booking[];
}

// ==========================================
// Booking Waitlist
// ==========================================
export type WaitlistStatus = "waiting" | "offered" | "booked" | "expired" | "cancelled";

export interface BookingWaitlistEntry {
  id: string;
  space_id: string;
  space?: Space;
  location_id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  customer_type: BookingCustomerType;
  contract_id?: string;
  lead_id?: string;
  lead?: Lead;
  guest_name?: string;
  guest_phone?: string;
  booker_phone?: string;
  status: WaitlistStatus;
  notified_at?: string;
  expires_at?: string;
  notes?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Booking Analytics Types
// ==========================================
export interface RoomUtilization {
  space_id: string;
  space_name: string;
  location_name: string;
  available_hours: number;
  booked_hours: number;
  utilization_pct: number;
  revenue: number;
  total_bookings: number;
  peak_hours: { hour: number; count: number }[];
}

export interface RevenueReport {
  period: string;
  total_revenue: number;
  by_payment_mode: { mode: string; amount: number }[];
  by_customer_type: { type: string; amount: number; count: number }[];
  by_space: { space_name: string; amount: number; count: number }[];
  cancellation_rate: number;
  no_show_rate: number;
  trend: { month: string; revenue: number; bookings: number }[];
}

export interface CustomerSegment {
  segment: string;
  label: string;
  description: string;
  count: number;
  customers: {
    lead_id?: string;
    name: string;
    company?: string;
    phone?: string;
    total_bookings: number;
    total_spent: number;
    last_visit?: string;
    avg_feedback?: number;
  }[];
}

// ==========================================
// Aggregator Types
// ==========================================
export type AggregatorStatus = "active" | "inactive" | "suspended";

export type VoPurpose = "gst_registration" | "mca_registration" | "branch_office" | "mail_handling" | "business_address";

export type EntityType = "individual" | "proprietorship" | "partnership" | "llp" | "pvt_ltd" | "public_ltd" | "trust" | "society" | "huf" | "other";

export interface Aggregator {
  id: string;
  name: string;
  code: string;
  status: AggregatorStatus;
  company_name?: string;
  gst_number?: string;
  pan_number?: string;
  email_domain?: string;
  primary_email?: string;
  primary_phone?: string;
  billing_address?: string;
  billing_city?: string;
  billing_state?: string;
  billing_pincode?: string;
  same_state_as_twv: boolean;
  commission_percentage: number;
  default_rate_card: Record<string, number>;
  billing_method: "postpaid" | "prepaid";
  // Proforma-First vs GST-Direct invoicing — mirrors contracts.billing_mode.
  billing_mode?: "proforma_first" | "gst_direct";
  credit_limit?: number;
  kyc_verified: boolean;
  kyc_verified_at?: string;
  agreement_signed: boolean;
  agreement_document_id?: string;
  notes?: string;
  tags: string[];
  contacts?: AggregatorContact[];
  rate_cards?: AggregatorRateCard[];
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface AggregatorContact {
  id: string;
  aggregator_id: string;
  name: string;
  email?: string;
  phone?: string;
  designation?: string;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AggregatorRateCard {
  id: string;
  aggregator_id: string;
  purpose: VoPurpose;
  location_id?: string;
  location?: Location;
  rate: number;
  tenure_months: number;
  description?: string;
  is_active: boolean;
  effective_from: string;
  effective_until?: string;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Case (Virtual Office) Types
// ==========================================
// Mirrors the case_status Postgres enum. Note grace_period was added to the
// enum in 00521's predecessor 00381 but never reached this type; 'paid' comes
// from 00521. The retired hand-off states stay here because historical rows
// still carry them.
export type CaseStatus =
  | "intake_received" | "docs_requested" | "docs_received" | "under_review"
  | "compliance_check" | "internal_approved" | "sent_for_client_approval"
  | "client_approved" | "signing_in_progress" | "executed"
  | "invoiced" | "paid" | "active"
  | "renewal_due" | "grace_period" | "renewed" | "lapsed";

export type CaseDocStatus = "pending" | "uploaded" | "approved" | "rejected" | "deferred";

export type ComplianceCheckStatus = "pending" | "passed" | "failed" | "waived";

export type AgreementStatus =
  | "draft" | "pending_internal_approval" | "internally_approved"
  | "sent_to_client" | "client_approved" | "signing" | "executed" | "expired";

export type EmailDirection = "inbound" | "outbound";

export type AggInvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled";

export interface VoCase {
  id: string;
  case_number: string;
  // Direct clients (no aggregator referral) have aggregator_id = null.
  case_source?: 'aggregator' | 'direct';
  aggregator_id?: string | null;
  aggregator?: Aggregator;
  // Prepaid-aggregator cases only: who the per-case invoice bills. Set
  // explicitly per case (varies case to case), no default.
  bill_to?: 'aggregator' | 'client' | null;
  aggregator_contact_id?: string;
  aggregator_contact?: AggregatorContact;
  location_id?: string;
  location?: Location;
  status: CaseStatus;
  purpose: VoPurpose;
  is_renewal: boolean;
  parent_case_id?: string;
  // End-client
  client_name: string;
  client_entity_type: EntityType;
  client_company_name?: string;
  client_gst_number?: string;
  client_pan_number?: string;
  client_cin_number?: string;
  client_email?: string;
  client_phone?: string;
  client_address?: string;
  client_city?: string;
  client_state?: string;
  client_pincode?: string;
  // Authorized representative signing on the client's behalf
  represented_by_name?: string;
  represented_by_designation?: string;
  represented_by_id_type?: 'pan' | 'aadhaar';
  represented_by_id_number?: string;
  // Financials
  rate?: number;
  tenure_months: number;
  start_date?: string;
  end_date?: string;
  security_deposit: number;
  // Agreement & Compliance
  agreement_id?: string;
  agreement_status?: AgreementStatus;
  ll_agreement_id?: string;
  ll_agreement_status?: AgreementStatus;
  // Populated by GET /api/cases/[id] only (latest row per type, or null) —
  // not present on list-page rows from GET /api/cases.
  agreement?: { status?: AgreementStatus } | null;
  ll_agreement?: { status?: AgreementStatus } | null;
  billing_statement?: {
    id: string;
    statement_number?: string | null;
    payment_status?: string | null;
    handoff_state?: string | null;
    total_amount?: number | null;
  } | null;
  /** Whether the renewal cron may notify anyone about this case. False for
   *  cases predating the end_date backfill — see migration 00526. */
  renewal_notices_enabled?: boolean;
  /** Agreed increase applied to the license fee on renewal; 0 renews flat.
   *  Written into the agreement's renewal clause — see migration 00527. */
  renewal_escalation_percentage?: number;
  compliance_passed: boolean;
  compliance_passed_at?: string;
  // Timestamps
  docs_requested_at?: string;
  docs_received_at?: string;
  review_started_at?: string;
  internal_approved_at?: string;
  internal_approved_by?: string;
  sent_for_client_approval_at?: string;
  client_approved_at?: string;
  signing_started_at?: string;
  executed_at?: string;
  invoiced_at?: string;
  activated_at?: string;
  renewal_due_at?: string;
  renewed_at?: string;
  lapsed_at?: string;
  // Email
  source_email_id?: string;
  email_thread_id?: string;
  // Meta
  assigned_to?: string;
  assignee?: User;
  notes?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface CaseDocument {
  id: string;
  case_id: string;
  document_id?: string;
  document?: CrmDocument;
  document_type: string;
  label: string;
  is_required: boolean;
  status: CaseDocStatus;
  reviewed_by?: string;
  reviewer?: User;
  reviewed_at?: string;
  rejection_reason?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface ContractDocument {
  id: string;
  contract_id: string;
  document_id?: string;
  document?: CrmDocument;
  document_type: string;
  label: string;
  is_required: boolean;
  status: CaseDocStatus; // pending | uploaded | approved | rejected | deferred
  reviewed_by?: string;
  reviewer?: User;
  reviewed_at?: string;
  rejection_reason?: string;
  notes?: string;
  // deferral fields
  deferred_by?: string;
  deferrer?: { id: string; full_name: string };
  deferred_at?: string;
  deferred_reason?: string;
  deferred_until?: string;
  created_at: string;
  updated_at: string;
}

export interface CaseComment {
  id: string;
  case_id: string;
  comment: string;
  is_internal: boolean;
  attachment_id?: string;
  attachment?: CrmDocument;
  created_by?: string;
  creator?: User;
  created_at: string;
  updated_at: string;
}

export interface CaseComplianceCheck {
  id: string;
  case_id: string;
  check_name: string;
  check_category?: string;
  status: ComplianceCheckStatus;
  checked_by?: string;
  checker?: User;
  checked_at?: string;
  notes?: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CaseAgreement {
  id: string;
  case_id: string;
  agreement_number: string;
  template_key: string;
  type?: 'proposal' | 'leave_license';
  status: AgreementStatus;
  variables: Record<string, unknown>;
  generated_document_id?: string;
  generated_document?: CrmDocument;
  signed_document_id?: string;
  signed_document?: CrmDocument;
  stamp_reference?: string | null;
  pre_stamp_status?: AgreementStatus | null;
  internal_approved_by?: string;
  internal_approved_at?: string;
  sent_to_client_at?: string;
  sent_to_email?: string;
  client_approved_at?: string;
  digio_document_id?: string;
  digio_sign_url?: string;
  digio_status?: string;
  leegality_document_id?: string;
  leegality_sign_url?: string;
  leegality_status?: string;
  leegality_estamp_value?: number;
  signed_at?: string;
  valid_from?: string;
  valid_until?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface CaseEmail {
  id: string;
  case_id: string;
  direction: EmailDirection;
  gmail_message_id?: string;
  gmail_thread_id?: string;
  from_email?: string;
  to_emails: string[];
  cc_emails: string[];
  subject?: string;
  body_preview?: string;
  has_attachments: boolean;
  parsed_data: Record<string, unknown>;
  processed_at?: string;
  created_at: string;
}

/** One case included in a postpaid aggregator consolidated billing_statements
 *  row. Replaces the JSONB-only snapshot AggregatorInvoice.items provides —
 *  a case is "billed for a period" iff a non-voided row exists here. */
export interface BillingStatementCase {
  id: string;
  billing_statement_id: string;
  case_id: string;
  case?: VoCase;
  amount: number;
  pro_rated_days?: number | null;
  total_days?: number | null;
  created_at: string;
}

export interface AggregatorInvoice {
  id: string;
  invoice_number: string;
  aggregator_id: string;
  aggregator?: Aggregator;
  // Links to the billing_statements row that actually feeds Accounts
  // Receivable / Tally Inbox. Null for invoices created before this link
  // existed — intentionally not backfilled.
  billing_statement_id?: string | null;
  billing_statement?: {
    id: string;
    statement_number: string | null;
    handoff_state: string | null;
    payment_status: string;
  } | null;
  period_month: number;
  period_year: number;
  status: AggInvoiceStatus;
  items: AggregatorInvoiceLineItem[];
  subtotal: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_amount: number;
  is_interstate: boolean;
  tax_percentage: number;
  sent_at?: string;
  sent_to?: string;
  paid_at?: string;
  payment_reference?: string;
  due_date?: string;
  notes?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface AggregatorInvoiceLineItem {
  case_id: string;
  case_number: string;
  client_name: string;
  purpose: VoPurpose;
  rate: number;
  pro_rated_days?: number;
  total_days?: number;
  amount: number;
}

// ==========================================
// Procurement Module
// ==========================================

export type ProcurementDepartment = "pantry" | "maintenance" | "administration" | "asset" | "amc" | "reimbursement";
export type VendorCategory = "pantry" | "maintenance" | "administration" | "general";
// Single source of truth is ITEM_UNITS in @/lib/constants — re-exported so the
// two lists can never drift apart again.
import type { ItemUnit } from "@/lib/constants";
export type { ItemUnit };
export type PrStatus = "draft" | "submitted" | "approved" | "rejected" | "partially_ordered" | "po_created" | "cancelled";
export type PoStatus = "pending" | "ordered" | "partially_received" | "received" | "invoice_received" | "invoice_approved" | "cancelled" | "partially_cancelled";
export type BillPaymentStatus = "unpaid" | "partially_paid" | "paid";
export type BillApprovalStatus = "pending" | "approved" | "rejected";
export type RejectionOutcome = "return" | "replacement" | "void";
export type PaymentBatchType = "immediate" | "15th" | "25th";

export interface VendorBillBatchChange {
  id: string;
  vendor_bill_id: string;
  changed_by?: string;
  changed_at: string;
  old_batch_type?: PaymentBatchType | null;
  new_batch_type?: PaymentBatchType | null;
  old_batch_date?: string | null;
  new_batch_date?: string | null;
  reason?: string | null;
  changer?: { id: string; full_name?: string } | null;
}

export interface ProcurementVendor {
  id: string;
  name: string;
  category: VendorCategory;
  contact_name?: string;
  contact_phone?: string;
  contact_email?: string;
  address?: string;
  gstin?: string;
  payment_terms?: string;
  terms_and_conditions?: string;
  notes?: string;
  is_active: boolean;
  // Bank details
  bank_name?: string;
  bank_account_holder?: string;
  bank_account_number?: string;
  bank_ifsc?: string;
  // KYC & compliance
  pan_number?: string;
  msme_number?: string;
  kyc_verified: boolean;
  kyc_verified_at?: string;
  kyc_verified_by?: string;
  // Document paths (Supabase Storage)
  pan_doc_path?: string;
  gst_cert_path?: string;
  reg_cert_path?: string;
  aadhar_doc_path?: string;
  msme_cert_path?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export type ItemType = "goods" | "service";
export type ServicePoBillingCycle = "monthly" | "quarterly" | "yearly";

export interface ProcurementItem {
  id: string;
  name: string;
  department: ProcurementDepartment;
  unit: ItemUnit;
  item_type: ItemType;
  standard_price?: number;
  gst_rate?: number;
  description?: string;
  // Catalog-level MOQ defaults (fallback Min/Max for locations without their own)
  default_reorder_level?: number | null;
  default_max_level?: number | null;
  is_active: boolean;
  is_suggested: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface PoServiceReport {
  id: string;
  po_id: string;
  cycle_number: number;
  period_from: string;
  period_to: string;
  report_file_url?: string | null;
  notes?: string | null;
  recorded_by?: string | null;
  created_at: string;
  recorder?: { id: string; full_name?: string } | null;
}

export interface PurchaseRequestItem {
  id: string;
  pr_id: string;
  item_id?: string;
  item_name: string;
  quantity: number;
  unit: ItemUnit;
  estimated_price?: number;
  total_estimated?: number;
  notes?: string;
  created_at: string;
  procurement_items?: ProcurementItem | null;
  // Computed by API — not DB columns
  already_ordered_qty?: number;
  remaining_qty?: number;
}

export interface PurchaseRequest {
  id: string;
  pr_number: string;
  department: ProcurementDepartment;
  location_id?: string;
  status: PrStatus;
  requested_by: string;
  approved_by?: string;
  approved_at?: string;
  approval_code?: string;
  rejection_reason?: string;
  notes?: string;
  expenditure_type: "operational" | "amc";
  total_estimated_amount: number;
  created_at: string;
  updated_at: string;
  // AMC service fields — only populated when department === "amc"
  service_item_name?: string | null;
  linked_asset_id?: string | null;
  amc_coverage_type?: "comprehensive" | "labour_only" | null;
  amc_start_date?: string | null;
  amc_end_date?: string | null;
  amc_visits_covered?: number | null;
  amc_contact_name?: string | null;
  amc_helpline_number?: string | null;
  amc_contact_email?: string | null;
  amc_escalation_name?: string | null;
  amc_escalation_phone?: string | null;
  amc_escalation2_name?: string | null;
  amc_escalation2_phone?: string | null;
  advance_amount?: number | null;
  advance_payment_mode?: "neft" | "rtgs" | "imps" | "bank_transfer" | "cheque" | "cash" | null;
  advance_notes?: string | null;
  // Reimbursement fields — only populated when department === "reimbursement"
  billable_contract_id?: string | null;
  // Joined fields
  locations?: { id: string; name: string } | null;
  requester?: { id: string; full_name?: string; email?: string } | null;
  approver?: { id: string; full_name?: string; email?: string } | null;
  purchase_request_items?: PurchaseRequestItem[];
  material_request_quotations?: MaterialRequestQuotation[];
  linked_asset?: { id: string; name: string; asset_code: string } | null;
  billable_contract?: {
    id: string;
    contract_number: string;
    tax_percentage?: number;
    billing_mode?: string;
    lead?: { id: string; first_name: string; last_name: string; company?: string } | null;
  } | null;
  reimbursement_statements?: Array<{
    id: string;
    statement_number: string;
    status: string;
    total_amount: number;
    voided_at: string | null;
    created_at: string;
    gst_invoice_number?: string | null;
    supporting_documents?: Array<{ id: string }>;
  }>;
}

export interface MaterialRequestQuotation {
  id: string;
  pr_id: string;
  vendor_name: string;
  amount: number;
  file_path: string;
  file_name: string;
  file_mime_type: string;
  notes?: string | null;
  uploaded_by?: string | null;
  created_at: string;
  // Joined / computed
  uploader?: { id: string; full_name?: string; email?: string } | null;
  signed_url?: string;
}

export interface ReimbursementSupportingDocument {
  id: string;
  billing_statement_id: string;
  file_path: string;
  file_name: string;
  file_mime_type: string;
  uploaded_by?: string | null;
  created_at: string;
  // Joined / computed
  uploader?: { id: string; full_name?: string; email?: string } | null;
  signed_url?: string;
}

export interface PurchaseOrderItem {
  id: string;
  po_id: string;
  pr_item_id?: string;
  item_id?: string;
  item_name: string;
  quantity_ordered: number;
  quantity_received: number;
  unit: ItemUnit;
  unit_price?: number;
  total_amount?: number;
  gst_rate?: number;
  gst_amount?: number;
  notes?: string;
  created_at: string;
  procurement_items?: { id: string; name: string; description?: string; gst_rate?: number } | null;
}

export interface PoDeliveryReceiptItem {
  id: string;
  delivery_receipt_id: string;
  po_item_id: string;
  qty_received: number;
}

export interface PoDeliveryReceipt {
  id: string;
  po_id: string;
  dc_number?: string | null;
  dc_date?: string | null;
  file_url?: string | null;
  notes?: string | null;
  received_by: string;
  received_at: string;
  created_at: string;
  receiver?: { id: string; full_name?: string; email?: string } | null;
  po_delivery_receipt_items?: PoDeliveryReceiptItem[];
}

export interface PoBillSummary {
  id: string;
  bill_number: string;
  invoice_date: string;
  invoice_file_url?: string | null;
  total_amount: number;
  payment_status: string;
  approval_status: BillApprovalStatus;
  created_at: string;
  service_report_id?: string | null;
  creator?: { id: string; full_name?: string } | null;
}

export type PoAdvanceStatus = "not_required" | "pending" | "processed";

export type AssetDocumentTier = "commercial" | "operational";

export interface AssetDocument {
  id: string;
  asset_id: string;
  tier: AssetDocumentTier;
  label: string;
  file_url: string;
  file_name?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  notes?: string | null;
  uploaded_by?: string | null;
  created_at: string;
  updated_at: string;
  uploader?: { id: string; full_name: string } | null;
}

export type AmcStatus = "inactive" | "active" | "expiring" | "exhausted" | "expired" | "terminated";
export type AmcEventType = "breakdown" | "preventive" | "remote_support" | "annual_service";

export interface AmcServiceEvent {
  id: string;
  po_id: string;
  event_number: number;
  event_type: AmcEventType;
  event_date: string;
  technician_name?: string | null;
  issue_description: string;
  resolution_notes?: string | null;
  next_scheduled_date?: string | null;
  report_file_url?: string | null;
  logged_by?: string | null;
  created_at: string;
  logger?: { id: string; full_name?: string } | null;
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  po_type: "goods" | "service";
  pr_id?: string;
  vendor_id: string;
  location_id?: string;
  status: PoStatus;
  ordered_by: string;
  expected_delivery_date?: string;
  actual_delivery_date?: string;
  // Service PO fields
  service_start_date?: string | null;
  billing_cycle?: ServicePoBillingCycle | null;
  cycle_count?: number | null;
  unit_cost_per_cycle?: number | null;
  notes?: string;
  payment_terms?: string;
  terms_and_conditions?: string;
  total_ordered_amount: number;
  total_gst_amount?: number;
  total_amount_with_gst?: number;
  // Advance payment fields
  advance_amount?: number | null;
  advance_payment_mode?: "cash" | "upi" | "bank_transfer" | null;
  advance_payment_reference?: string | null;
  advance_notes?: string | null;
  advance_status?: PoAdvanceStatus;
  advance_approval_status?: "pending_review" | "approved" | "rejected" | null;
  advance_processed_by?: string | null;
  advance_processed_at?: string | null;
  advance_payment_date?: string | null;
  // AMC fields
  amc_start_date?: string | null;
  amc_end_date?: string | null;
  amc_visits_covered?: number | null;  // null = unlimited
  amc_visits_used?: number;
  amc_contact_name?: string | null;
  amc_helpline_number?: string | null;
  amc_contact_email?: string | null;
  amc_status?: AmcStatus;
  amc_terminated_at?: string | null;
  amc_terminated_by?: string | null;
  amc_termination_reason?: string | null;
  terminator?: { id: string; full_name?: string } | null;
  linked_asset_id?: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  procurement_vendors?: Pick<ProcurementVendor, "id" | "name"> | null;
  locations?: { id: string; name: string } | null;
  orderer?: { id: string; full_name?: string; email?: string } | null;
  purchase_requests?: (Pick<PurchaseRequest, "id" | "pr_number" | "department" | "approval_code" | "approved_at" | "expenditure_type"> & {
    approver?: { id: string; full_name?: string; email?: string } | null;
  }) | null;
  purchase_order_items?: PurchaseOrderItem[];
  po_delivery_receipts?: PoDeliveryReceipt[];
  po_service_reports?: PoServiceReport[];
  amc_service_events?: AmcServiceEvent[];
  vendor_bills?: PoBillSummary[];
}

export interface VendorBill {
  id: string;
  bill_number: string;
  po_id?: string;
  vendor_id: string;
  invoice_number?: string;
  invoice_date: string;
  due_date?: string;
  total_amount: number;
  amount_paid: number;
  payment_status: BillPaymentStatus;
  payment_mode?: string;
  payment_reference?: string;
  payment_date?: string;
  notes?: string;
  invoice_file_url?: string;
  service_report_id?: string | null;
  approval_status: BillApprovalStatus;
  approved_by?: string;
  approved_at?: string;
  approval_code?: string;
  approved_amount?: number | null;
  approved_amount_note?: string | null;
  approved_amount_reason?: string | null;
  gst_rate?: number | null;
  gst_amount?: number | null;
  base_amount?: number | null;
  rejection_reason?: string;
  rejection_outcome?: RejectionOutcome;
  // Payment batch scheduling
  payment_batch_type?: PaymentBatchType | null;
  payment_batch_date?: string | null;
  payment_batch_assigned_by?: string | null;
  payment_batch_assigned_at?: string | null;
  // Replacement lineage — when this bill replaces a previously rejected one
  replaces_bill_id?: string | null;
  // Manual accounting classification (used when po_id is null — direct expense)
  manual_department?: string | null;
  manual_expenditure_type?: string | null;
  // Set when this vendor bill was auto-created from a landlord electricity bill
  electricity_bill_id?: string | null;
  // Set when this bill skipped manual approval via an active recurring bill rule
  auto_approved: boolean;
  recurring_rule_id?: string | null;
  auto_approval_note?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  procurement_vendors?: Pick<ProcurementVendor, "id" | "name"> | null;
  electricity_bill?: {
    bill_month: number;
    bill_year: number;
    landlord_total_amount: number;
    landlord_gst_applicable: boolean;
    landlord_gst_rate: number | null;
    landlord_gst_amount: number | null;
    electricity_bill_lines: {
      line_type: string;
      meter_label: string | null;
      label: string | null;
      units: number | null;
      rate: number | null;
      amount: number | null;
    }[];
  } | null;
  purchase_orders?: (Pick<PurchaseOrder, "id" | "po_number" | "po_type" | "expected_delivery_date"> & {
    purchase_requests?: { department: string; expenditure_type: string } | null;
  }) | null;
  approver?: { id: string; full_name?: string } | null;
  vendor_bill_batch_changes?: VendorBillBatchChange[];
  vendor_bill_payments?: Array<{
    id: string; amount: number; payment_mode: string;
    payment_reference: string | null; payment_date: string;
    notes: string | null;
    partial_reason: string | null;
    recorder: { id: string; full_name: string } | null;
  }>;
}

export type RecurringBillRuleStatus = "active" | "paused";

export interface RecurringBillRule {
  id: string;
  vendor_id: string;
  department: string;
  billing_cycle: ServicePoBillingCycle;
  expected_amount: number;
  tolerance_percent: number;
  max_auto_approve_amount: number;
  default_batch_type: PaymentBatchType;
  status: RecurringBillRuleStatus;
  anchor_bill_id: string;
  first_bill_id?: string | null;
  notes?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  procurement_vendors?: Pick<ProcurementVendor, "id" | "name"> | null;
  anchor_bill?: Pick<VendorBill, "id" | "bill_number" | "total_amount" | "invoice_date"> | null;
  latest_bill?: Pick<VendorBill, "id" | "bill_number" | "invoice_date" | "total_amount"> | null;
  creator?: { id: string; full_name?: string } | null;
}

export interface ItemHistoryEntry {
  id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit: string;
  unit_price?: number;
  total_amount?: number;
  purchase_orders: {
    id: string;
    po_number: string;
    status: string;
    created_at: string;
    expected_delivery_date?: string;
    actual_delivery_date?: string;
    procurement_vendors?: { id: string; name: string } | null;
    locations?: { id: string; name: string } | null;
  };
}

export interface ProcurementDashboardStats {
  pending_approval_count: number;
  monthly_spend_by_dept: { department: ProcurementDepartment; total: number }[];
  overdue_bills_count: number;
  recent_requests: Pick<PurchaseRequest, "id" | "pr_number" | "department" | "status" | "total_estimated_amount" | "created_at">[];
}

// ==========================================
// Prepaid Package Types
// ==========================================
export type CreditType = "hours" | "days" | "bookings";
export type PrepaidPurchaseStatus = "active" | "exhausted" | "expired";

export interface PrepaidPackage {
  id: string;
  name: string;
  description?: string;
  location_id?: string;
  location?: Location;
  workspace_type?: WorkspaceType;
  space_id?: string;
  space?: Space;
  credit_type: CreditType;
  total_credits: number;
  price: number;
  validity_days: number;
  is_active: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface PrepaidPurchase {
  id: string;
  package_id: string;
  package?: PrepaidPackage;
  location_id?: string;
  location?: Location;
  lead_id?: string;
  lead?: Lead;
  company_name?: string;
  credit_type: CreditType;
  total_credits: number;
  credits_used: number;
  credits_remaining: number;   // computed by API: total_credits - credits_used
  price_paid: number;
  payment_mode: string;
  payment_reference?: string;
  purchased_at: string;
  expires_at: string;
  status: PrepaidPurchaseStatus;
  payment_status: 'pending_payment' | 'paid';
  razorpay_payment_link_id?: string;
  razorpay_payment_link_url?: string;
  notes?: string;
  sold_by?: string;
  seller?: User;
  extended_by?: string;
  extended_at?: string;
  extension_notes?: string;
  created_at: string;
  updated_at: string;
  redemptions?: PrepaidRedemption[];
}

export interface PrepaidRedemption {
  id: string;
  purchase_id: string;
  booking_id: string;
  booking?: Booking;
  credits_deducted: number;
  redeemed_by?: string;
  redeemer?: User;
  redeemed_at: string;
}

// ==========================================
// Petty Cash Types
// ==========================================

export interface PettyCashCategory {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PettyCashBook {
  id: string;
  user_id: string;
  current_balance: number;
  created_at: string;
  updated_at: string;
  owner?: Pick<User, "id" | "full_name" | "email" | "role">;
}

export type PcRequestStatus = "pending" | "approved" | "issued" | "rejected";
export type PcEntryStatus = "pending_manager" | "pending_admin" | "approved" | "rejected";
export type PcIssuanceMethod = "cash" | "upi" | "bank_transfer" | "cheque";

export interface PettyCashRequest {
  id: string;
  request_number: string;
  book_id: string;
  amount_requested: number;
  purpose: string;
  status: PcRequestStatus;
  approved_by?: string;
  approved_at?: string;
  rejection_note?: string;
  issued_by?: string;
  issued_at?: string;
  issuance_method?: PcIssuanceMethod;
  issuance_reference?: string;
  issuance_proof_url?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  // joined
  book?: PettyCashBook;
  requester?: Pick<User, "id" | "full_name" | "email">;
  approver?: Pick<User, "id" | "full_name">;
  issuer?: Pick<User, "id" | "full_name">;
}

export interface PettyCashEntry {
  id: string;
  entry_number: string;
  book_id: string;
  date: string;
  amount: number;
  category_id?: string;
  description: string;
  receipt_url?: string;
  po_id?: string;
  status: PcEntryStatus;
  rejection_note?: string;
  submitted_by: string;
  created_at: string;
  updated_at: string;
  // joined
  book?: PettyCashBook;
  category?: PettyCashCategory;
  submitter?: Pick<User, "id" | "full_name" | "email">;
  purchase_order?: { id: string; po_number: string };
}

export interface PettyCashApproval {
  id: string;
  approval_type: "request" | "entry";
  request_id?: string;
  entry_id?: string;
  approver_id: string;
  approval_level: "manager" | "admin";
  decision: "approved" | "rejected";
  note?: string;
  decided_at: string;
  approver?: Pick<User, "id" | "full_name">;
}

// ─── Inventory & Stock Transfer Types ────────────────────────────────────────

export type TransferStatus = "draft" | "pending_approval" | "approved" | "dispatched" | "received" | "completed" | "issue_raised";
export type TransferIssueType = "shortage" | "excess" | "damage" | "wrong_item" | "quality" | "other";
export type TransferIssueStatus = "open" | "investigating" | "resolved";
export type ConsumptionStatus = "active" | "voided";
export type CorrectionType = "void" | "adjust" | "relog";

export interface LocationStock {
  id: string;
  location_id: string;
  item_id: string;
  quantity_on_hand: number;
  reorder_level: number;
  last_updated: string;
  locations?: { id: string; name: string; code: string } | null;
  procurement_items?: { id: string; name: string; department: string; unit: string; item_type: string; is_active?: boolean } | null;
}

export interface StockTransferItem {
  id: string;
  transfer_id: string;
  item_id?: string;
  item_name: string;
  unit: string;
  quantity_requested: number;
  quantity_approved: number | null;
  quantity_sent: number;
  quantity_received: number;
  notes?: string;
  // Set once an approver explicitly saves this line's decision — the
  // transfer as a whole can't move to "approved" until every item has this.
  approval_confirmed_at?: string | null;
  approval_confirmed_by?: string | null;
  procurement_items?: { id: string; name: string } | null;
}

export interface StockTransferAttachment {
  id: string;
  transfer_id: string;
  issue_id?: string | null;
  file_url: string;
  file_path: string;
  file_type: string;
  caption?: string | null;
  uploaded_by?: string;
  uploaded_at: string;
  uploader?: { id: string; full_name?: string } | null;
}

export interface StockTransferIssue {
  id: string;
  transfer_id: string;
  transfer_item_id: string;
  issue_type: TransferIssueType;
  reported_quantity: number;
  expected_quantity: number;
  description?: string;
  status: TransferIssueStatus;
  resolved_by?: string;
  resolved_at?: string;
  resolution_notes?: string;
  created_at: string;
  resolver?: { id: string; full_name?: string } | null;
}

export interface StockTransfer {
  id: string;
  transfer_number: string;
  from_location_id: string;
  to_location_id: string;
  status: TransferStatus;
  // 'manual' (default) or 'replenishment' (created from an MOQ refill suggestion)
  origin?: "manual" | "replenishment";
  initiated_by: string;
  approved_by?: string;
  approved_at?: string;
  dispatched_at?: string;
  received_by?: string;
  received_at?: string;
  notes?: string;
  approver_notes?: string | null;
  created_at: string;
  updated_at: string;
  from_location?: { id: string; name: string; code: string } | null;
  to_location?: { id: string; name: string; code: string } | null;
  initiator?: { id: string; full_name?: string } | null;
  approver?: { id: string; full_name?: string } | null;
  receiver?: { id: string; full_name?: string } | null;
  stock_transfer_items?: StockTransferItem[];
  stock_transfer_issues?: StockTransferIssue[];
  stock_transfer_attachments?: StockTransferAttachment[];
}

export interface ConsumptionLogItem {
  id: string;
  consumption_log_id: string;
  item_id?: string;
  item_name: string;
  unit: string;
  quantity_consumed: number;
  notes?: string;
}

export interface ConsumptionCorrection {
  id: string;
  consumption_log_item_id?: string;
  consumption_log_id: string;
  correction_type: CorrectionType;
  original_quantity: number;
  new_quantity: number;
  reason: string;
  corrected_by: string;
  new_consumption_log_id?: string;
  created_at: string;
  corrector?: { id: string; full_name?: string } | null;
}

export interface ConsumptionLog {
  id: string;
  location_id: string;
  logged_by: string;
  logged_at: string;
  status: ConsumptionStatus;
  notes?: string;
  created_at: string;
  locations?: { id: string; name: string } | null;
  logger?: { id: string; full_name?: string } | null;
  consumption_log_items?: ConsumptionLogItem[];
  consumption_corrections?: ConsumptionCorrection[];
}

export type BeverageType =
  | "tea"
  | "warm_milk"
  | "espresso"
  | "cappuccino"
  | "coffee_latte"
  | "flat_white"
  | "ristretto"
  | "milk_foam";

export interface BeverageLogItem {
  id: string;
  beverage_log_id: string;
  drink_type: BeverageType;
  quantity: number;
}

export interface BeverageLog {
  id: string;
  location_id: string;
  logged_by: string;
  logged_at: string;
  notes?: string;
  photo_path?: string | null;
  photo_url?: string | null;
  created_at: string;
  locations?: { id: string; name: string } | null;
  logger?: { id: string; full_name?: string } | null;
  beverage_log_items?: BeverageLogItem[];
}

// ==========================================
// Space Management Types
// ==========================================

export type SpaceUnitType =
  | "hot_desk"
  | "dedicated_desk"
  | "private_cabin"
  | "managed_office"
  | "business_centre";

export interface LocationFloor {
  id: string;
  location_id: string;
  location?: Location;
  name: string;
  floor_number?: number | null;
  total_area_sqft: number;
  leasable_area_sqft: number;
  grid_cols: number;
  grid_rows: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  space_units?: SpaceUnit[];
}

export interface SpaceUnit {
  id: string;
  location_id: string;
  location?: Location;
  floor_id?: string | null;
  floor?: LocationFloor;
  name: string;
  code: string;
  type: SpaceUnitType;
  capacity: number;
  area_sqft?: number | null;
  monthly_rate: number | null;          // null for business_centre (hourly-only)
  daily_rate?: number | null;
  hourly_rate?: number | null;          // primary rate for business_centre
  amenities: string[];
  is_active: boolean;
  notes?: string | null;
  grid_col: number;
  grid_row: number;
  grid_col_span: number;
  grid_row_span: number;
  color?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  active_allocations?: ContractSpaceAllocation[];
}

export interface ContractSpaceAllocation {
  id: string;
  contract_id: string;
  contract?: {
    id: string;
    contract_number: string;
    title: string;
    status: string;
    start_date: string;
    end_date?: string | null;
  };
  space_unit_id: string;
  space_unit?: SpaceUnit;
  allocated_at: string;
  start_date: string;
  end_date?: string | null;
  status: "active" | "ended";
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FloorCUF {
  floor_id: string;
  floor_name: string;
  total_area_sqft: number;
  leasable_area_sqft: number;
  cuf: number; // leasable / total, 0–1
}

export interface SpaceTypeOccupancy {
  type: SpaceUnitType;
  total_units: number;
  total_capacity: number;
  contracted_units: number;
  contracted_capacity: number;
  occupancy_rate: number; // 0–1
}

export interface SpaceRevenueRow {
  type: SpaceUnitType;
  total_units: number;
  contracted_units: number;
  monthly_revenue_contracted: number;
  monthly_revenue_potential: number;
  units: {
    unit_id: string;
    unit_name: string;
    unit_code: string;
    monthly_rate: number | null;
    hourly_rate?: number | null;
    contract_number?: string;
    contract_status?: string;
  }[];
}

export interface SpaceAnalytics {
  floors: FloorCUF[];
  overall_cuf: number;
  occupancy: SpaceTypeOccupancy[];
  revenue: SpaceRevenueRow[];
  idle_units: SpaceUnit[];
}

// ==========================================
// Seat Occupant Types
// ==========================================
export type SeatOccupantStatus = "active" | "ended" | "transferred";

export interface SpaceSeatOccupant {
  id: string;
  space_unit_id: string;
  space_unit?: SpaceUnit;
  contract_id: string;
  location_id: string;
  seat_label?: string;
  occupant_name: string;
  occupant_email?: string;
  occupant_phone?: string;
  start_date: string;
  end_date?: string;
  status: SeatOccupantStatus;
  transferred_to_id?: string;
  transferred_to?: SpaceSeatOccupant;
  loi_number?: string | null;
  notes?: string;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Headcount Types
// ==========================================
export interface SpaceHeadcount {
  id: string;
  location_id: string;
  location?: { id: string; name: string; code: string; capacity_config?: LocationCapacityConfig } | null;
  recorded_at: string;
  recorded_by?: string | null;
  recorder?: { id: string; full_name: string } | null;
  open_desk?: number | null;
  private_cabin?: number | null;
  meeting_room?: number | null;
  conference_room?: number | null;
  total_count: number;
  notes?: string | null;
  created_at: string;
  energy_reading_wh?: number | null;
  energy_today_wh?: number | null;
  energy_device_id?: string | null;
  energy_captured_at?: string | null;
}

// ==========================================
// Facility Issues Module
// ==========================================
export type FacilityScope = "it" | "hvac" | "plumbing" | "electrical" | "housekeeping" | "security" | "other" | "facility";
export type FacilityIssuePriority = "low" | "medium" | "high" | "critical";
export type FacilityIssueStatus = "new" | "acknowledged" | "in_progress" | "resolved" | "closed" | "reopened";
export type FacilityRootCause =
  | "hardware_failure"
  | "config_issue"
  | "isp_outage"
  | "power_issue"
  | "user_error"
  | "scheduled_maintenance"
  | "wear_and_tear"
  | "environmental"
  | "unknown"
  | "other";
export type FacilityReportedVia = "walk_in" | "phone" | "whatsapp" | "email" | "self_service" | "proactive" | "feedback";
export type FacilityTaskType = "reported_problem" | "delegated_task";
export type FacilityAssetStatus = "active" | "maintenance" | "retired";
export type FacilityLifecycleStage = "procured" | "installed" | "testing_commissioning" | "operational" | "under_amc" | "decommissioned";
export type FacilityAttachmentPhase = "report" | "progress" | "resolution";
export type FacilityTatReason =
  | "vendor_delay" | "awaiting_parts" | "dependent_team" | "requester_unavailable"
  | "underestimated_effort" | "competing_priorities" | "other";

export interface CategoryCustomField {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "date" | "boolean";
  required?: boolean;
  options?: string[];
}

export interface FacilityAssetCategory {
  id: string;
  scope: FacilityScope;
  name: string;
  slug: string;
  icon?: string | null;
  description?: string | null;
  default_sla_critical_hrs: number;
  default_sla_high_hrs: number;
  default_sla_medium_hrs: number;
  default_sla_low_hrs: number;
  default_assignee_id?: string | null;
  backup_assignee_id?: string | null;
  sort_order: number;
  is_active: boolean;
  custom_field_schema?: CategoryCustomField[] | null;
  created_at: string;
  updated_at: string;
}

export interface FacilityDepartmentMember {
  id: string;
  department_id: string;
  user_id: string;
  user?: { id: string; full_name: string; email: string; role: string } | null;
  added_by?: string | null;
  added_at: string;
}

export interface FacilityDepartment {
  id: string;
  scope: FacilityScope;
  head_user_id?: string | null;
  head?: { id: string; full_name: string; email: string; role: string } | null;
  is_active: boolean;
  members?: FacilityDepartmentMember[];
  created_at: string;
  updated_at: string;
}

export interface FacilityAsset {
  id: string;
  location_id: string;
  location?: { id: string; name: string; code: string } | null;
  floor_id?: string | null;
  floor?: { id: string; name: string } | null;
  space_unit_id?: string | null;
  space_unit?: { id: string; name: string; code: string } | null;
  category_id: string;
  category?: FacilityAssetCategory | null;
  name: string;
  asset_code: string;
  make?: string | null;
  model?: string | null;
  serial_number?: string | null;
  mac_address?: string | null;
  ip_address?: string | null;
  purchase_date?: string | null;
  warranty_expiry?: string | null;
  vendor?: string | null;
  status: FacilityAssetStatus;
  lifecycle_stage?: FacilityLifecycleStage | null;
  installation_date?: string | null;
  commissioned_at?: string | null;
  commissioned_by?: string | null;
  custom_field_values?: Record<string, unknown> | null;
  procurement_po_id?: string | null;
  location_notes?: string | null;
  notes?: string | null;
  attention_notes?: string | null;
  assigned_department?: string | null;
  next_service_due?: string | null;
  sort_order: number;
  created_by?: string | null;
  creator?: { id: string; full_name: string } | null;
  created_at: string;
  updated_at: string;
  photos?: { url: string; path: string; size: number }[];
  // Aggregates (when requested)
  open_issue_count?: number;
  total_issue_count?: number;
  last_issue_at?: string | null;
}

export type FacilityAssetEventType =
  | "maintenance" | "inspection" | "fault_observed" | "part_replaced"
  | "cleaning" | "installation" | "relocation" | "other";

export interface FacilityAssetEvent {
  id: string;
  asset_id: string;
  event_type: FacilityAssetEventType;
  note: string | null;
  photo_urls: string[];
  logged_by: string | null;
  logger?: { id: string; full_name: string } | null;
  issue_id?: string | null;
  issue?: { id: string; issue_number: string; title: string; status: string } | null;
  created_at: string;
}

export interface FacilityIssueAttachment {
  id: string;
  issue_id: string;
  file_url: string;
  file_path: string;
  file_type: "image" | "document";
  caption?: string | null;
  phase: FacilityAttachmentPhase;
  uploaded_by?: string | null;
  uploader?: { id: string; full_name: string } | null;
  uploaded_at: string;
}

export interface FacilityIssueTatExtension {
  id: string;
  issue_id: string;
  requested_by?: string | null;
  requester?: { id: string; full_name: string } | null;
  reason_category: FacilityTatReason;
  explanation: string;
  added_hours: number;
  previous_target_at: string;
  new_target_at: string;
  kpi_exempt: boolean;
  pass_card_by?: string | null;
  pass_card_note?: string | null;
  created_at: string;
}

export interface FacilityIssueEvent {
  id: string;
  issue_id: string;
  event_type:
    | "created"
    | "status_changed"
    | "assigned"
    | "comment"
    | "photo_added"
    | "resolved"
    | "reopened"
    | "sla_breached"
    | "satisfaction"
    | "priority_changed"
    | string;
  actor_id?: string | null;
  actor?: { id: string; full_name: string } | null;
  actor_label?: string | null;
  message?: string | null;
  payload?: Record<string, unknown>;
  created_at: string;
}

export interface FacilityIssue {
  id: string;
  issue_number: string;
  scope: FacilityScope;
  category_id: string;
  category?: FacilityAssetCategory | null;
  location_id: string;
  location?: { id: string; name: string; code: string } | null;
  floor_id?: string | null;
  floor?: { id: string; name: string } | null;
  space_unit_id?: string | null;
  space_unit?: { id: string; name: string; code: string } | null;
  asset_id?: string | null;
  asset?: { id: string; name: string; asset_code: string } | null;
  title: string;
  description?: string | null;
  priority: FacilityIssuePriority;
  status: FacilityIssueStatus;
  reported_by?: string | null;
  reporter?: { id: string; full_name: string } | null;
  reporter_name?: string | null;
  reporter_email?: string | null;
  reporter_phone?: string | null;
  reported_via: FacilityReportedVia;
  linked_feedback_id?: string | null;
  task_type: FacilityTaskType;
  assigned_to?: string | null;
  assignee?: { id: string; full_name: string } | null;
  assigned_at?: string | null;
  assigned_by?: string | null;
  reported_at: string;
  acknowledged_at?: string | null;
  started_at?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  sla_target_at?: string | null;
  sla_breached: boolean;
  tat_hours?: number | null;
  tat_manual_override?: boolean;
  tat_extension_count?: number;
  tat_extensions?: FacilityIssueTatExtension[];
  kpi_points?: number | null;
  kpi_breakdown?: { label: string; delta: number }[] | null;
  claimed_at?: string | null;
  claim_sla_target_at?: string | null;
  claim_sla_breached?: boolean;
  resolution_root_cause?: FacilityRootCause | null;
  resolution_notes?: string | null;
  resolution_time_minutes?: number | null;
  parts_cost: number;
  parts_notes?: string | null;
  satisfaction_rating?: number | null;
  satisfaction_comment?: string | null;
  satisfaction_token?: string | null;
  satisfaction_requested_at?: string | null;
  satisfaction_received_at?: string | null;
  reopen_count: number;
  created_at: string;
  updated_at: string;
  attachments?: FacilityIssueAttachment[];
  events?: FacilityIssueEvent[];
}

// Analytics shapes
export interface FacilityDashboardSummary {
  open_count: number;
  open_by_priority: Record<FacilityIssuePriority, number>;
  resolved_period: number;
  resolved_period_prev: number;
  avg_resolution_minutes: number;
  sla_compliance_pct: number;
  sla_compliance_pct_prev: number;
  sla_breached_open: number;
}

export interface FacilityHotSpot {
  location_id: string;
  location_name: string;
  total_issues: number;
  by_priority: Record<FacilityIssuePriority, number>;
}

export interface FacilityCategoryBreakdownRow {
  location_id: string;
  location_name: string;
  by_category: Array<{ category_id: string; category_name: string; count: number }>;
}

export interface FacilityTrendPoint {
  bucket: string;        // ISO date or week label
  total: number;
  by_location?: Record<string, number>;
}

export interface FacilityRecurringIssue {
  asset_id?: string | null;
  asset_name?: string | null;
  asset_code?: string | null;
  location_id: string;
  location_name: string;
  category_id: string;
  category_name: string;
  count: number;
  last_at: string;
}

export interface FacilityTechnicianKpi {
  technician_id: string;
  technician_name: string;
  assigned: number;
  resolved: number;
  avg_ack_minutes: number;
  avg_resolution_minutes: number;
  sla_compliance_pct: number;
  reopen_rate_pct: number;
  avg_satisfaction: number | null;
  satisfaction_responses: number;
}

// ==========================================
// Booking add-ons (extras: extended time, F&B, services)
// ==========================================
export type BookingAddonType = "extended_time" | "service" | "food_beverage" | "other";

export interface BookingAddon {
  id: string;
  booking_id: string;
  addon_catalog_id?: string | null;
  addon_type: BookingAddonType;
  description: string;
  unit_label?: string | null;
  quantity: number;
  unit_price: number;       // ex-GST
  amount: number;           // = quantity × unit_price
  gst_rate: number;
  gst_amount: number;
  total_with_gst: number;
  notes?: string | null;
  added_by?: string | null;
  added_by_user?: { id: string; full_name: string } | null;
  added_at: string;
  created_at: string;
  updated_at: string;
}

export interface AddonCatalogItem {
  id: string;
  location_id?: string | null;       // null = global
  addon_type: BookingAddonType;
  name: string;
  description?: string | null;
  unit_price: number;                // ex-GST
  unit_label?: string | null;
  gst_rate: number;
  is_active: boolean;
  sort_order: number;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Service Quotas (printing, future: meeting hours, coffee, etc.)
// ==========================================
export type ServicePricingModel = "per_unit";
export type ServiceUsageSource = "printer_report" | "manual" | "meeting_booking" | "other";
export type ServiceImportStatus = "preview" | "confirmed" | "voided";
export type ServiceImportSource = "printer_report";
export type PrintTemplateQuotaFormat = "used_slash_quota" | "used_only";

export interface ServiceCatalogItem {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  unit_label: string;
  pricing_model: ServicePricingModel;
  default_overage_rate: number;
  gst_rate: number;
  // Used by the printer importer to know whether this catalog row maps to
  // the B&W or Colour column ("bw" | "colour" | null).
  printer_column?: "bw" | "colour" | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ContractServiceQuota {
  id: string;
  contract_id: string;
  service_id: string;
  service?: ServiceCatalogItem | null;
  monthly_quota: number;
  overage_rate: number;
  notes?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProposalServiceQuota {
  id: string;
  proposal_id: string;
  service_id: string;
  service?: ServiceCatalogItem | null;
  monthly_quota: number;
  overage_rate: number;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceUsageRecord {
  id: string;
  contract_id?: string | null;        // NULL = unmapped / internal use
  contract?: { id: string; contract_number: string } | null;
  service_id: string;
  service?: ServiceCatalogItem | null;
  location_id: string;
  period_year: number;
  period_month: number;

  quantity_used: number;
  quota_snapshot: number;
  overage_rate_snapshot: number;
  overage_quantity: number;
  amount: number;
  gst_rate: number;
  gst_amount: number;
  total_with_gst: number;

  source: ServiceUsageSource;
  source_ref?: string | null;
  detail?: Record<string, unknown> | null;

  billing_statement_id?: string | null;
  is_billed: boolean;

  notes?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceImportPreviewRow {
  dept_id: string;
  contract_id?: string | null;
  contract_number?: string | null;
  customer_name?: string | null;
  bw_used: number;
  bw_quota_report?: number | null;     // quota as printed in the report (for sanity check)
  bw_quota_contract: number;           // CRM-side quota — source of truth
  bw_overage_qty: number;
  bw_overage_amount: number;
  colour_used: number;
  colour_quota_report?: number | null;
  colour_quota_contract: number;
  colour_overage_qty: number;
  colour_overage_amount: number;
  total_amount: number;                // ex-GST sum across services
  is_unmapped: boolean;
  is_excluded?: boolean;               // admin chose to skip this row
  flags?: string[];                    // e.g. ['quota_mismatch', 'no_contract_quota']
  raw?: Record<string, unknown>;
}

export interface ServiceUsageImport {
  id: string;
  location_id: string;
  location?: { id: string; name: string; code: string } | null;
  source: ServiceImportSource;
  period_year: number;
  period_month: number;
  filename?: string | null;
  file_path?: string | null;
  file_size_bytes?: number | null;
  total_rows: number;
  mapped_rows: number;
  unmapped_rows: number;
  total_overage_amount: number;
  total_with_gst: number;
  status: ServiceImportStatus;
  imported_by?: string | null;
  imported_at: string;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
  voided_by?: string | null;
  voided_at?: string | null;
  voided_reason?: string | null;
  preview_rows: ServiceImportPreviewRow[];
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

// ==========================================
// In-App Notification Types
// ==========================================

export type InAppNotificationType =
  | "facility_created"
  | "facility_comment"
  | "facility_assigned"
  | "facility_status_changed";

export interface InAppNotification {
  id: string;
  user_id: string;
  type: InAppNotificationType | string;
  title: string;
  body: string;
  url: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface LocationPrintTemplate {
  id: string;
  location_id: string;
  header_rows: number;
  data_start_row: number;
  // Excel column letters
  dept_id_col: string;
  bw_total_col?: string | null;
  colour_total_col?: string | null;
  bw_copy_col?: string | null;
  bw_print_col?: string | null;
  bw_scan_col?: string | null;
  colour_copy_col?: string | null;
  colour_print_col?: string | null;
  colour_scan_col?: string | null;
  quota_format: PrintTemplateQuotaFormat;
  ignore_dept_ids?: string[] | null;
  sample_file_path?: string | null;
  sample_file_name?: string | null;
  notes?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
}

// ==========================================
// Rent Management Module
// ==========================================

export type LandlordKycStatus = "pending" | "verified" | "incomplete";
export type LeaseStatus = "active" | "expired" | "terminated" | "on_hold";
export type LeaseEscalationType = "none" | "percentage" | "flat" | "step_up";
export type LeaseEscalationFrequency = "annual" | "bi_annual" | "custom";
export type LeaseEscalationStatus = "scheduled" | "applied" | "disputed" | "waived";
export type LeasePaymentStatus = "pending" | "approved" | "paid" | "overdue" | "on_hold" | "disputed";
export type LeasePaymentMode = "bank_transfer" | "cheque" | "neft" | "rtgs" | "upi";
export type LeaseHandoverType = "takeover" | "return" | "mid_term_addition";
export type LeaseHandoverStatus = "pending" | "completed" | "disputed";
export type LeaseDocumentType = "lease_deed" | "floor_plan" | "electrical_drawing" | "noc" | "amendment" | "correspondence" | "other";
export type AssetCategory = "civil" | "electrical" | "furniture" | "equipment" | "it" | "fitting" | "other";
export type AssetCondition = "excellent" | "good" | "fair" | "poor";
export type LeaseServiceName = "electricity" | "water" | "cam" | "security" | "parking" | "wifi" | "generator" | "hvac" | "housekeeping" | "other";
export type TdsSection = "194I" | "194IB";

export interface Landlord {
  id: string;
  name: string;
  contact_person?: string | null;
  email?: string | null;
  phone?: string | null;
  pan_number?: string | null;
  gstin?: string | null;
  registered_address?: string | null;
  kyc_status: LandlordKycStatus;
  notes?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  bank_accounts?: LandlordBankAccount[];
  active_lease_count?: number;
}

export interface LandlordBankAccount {
  id: string;
  landlord_id: string;
  bank_name: string;
  account_number: string;
  ifsc_code: string;
  account_holder_name?: string | null;
  is_primary: boolean;
  is_verified: boolean;
  created_at: string;
}

export interface PropertyLease {
  id: string;
  location_id: string;
  landlord_id?: string | null;
  lease_number?: string | null;
  registered_deed_number?: string | null;
  lease_start_date: string;
  lease_end_date: string;
  lock_in_end_date?: string | null;
  base_rent_amount: number;
  security_deposit_amount: number;
  rent_due_day: number;
  advance_months: number;
  escalation_type: LeaseEscalationType;
  escalation_value?: number | null;
  escalation_frequency: LeaseEscalationFrequency;
  next_escalation_date?: string | null;
  tds_applicable: boolean;
  tds_section: TdsSection;
  tds_rate: number;
  status: LeaseStatus;
  approval_mode: "manual" | "blanket";
  blanket_expires_on?: string | null;   // null = full tenure, date = until that date
  blanket_on_hold: boolean;             // true = blanket paused
  blanket_hold_until?: string | null;   // null = indefinite, date = auto-lifts on that date
  notes?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  location?: { id: string; name: string; city?: string | null } | null;
  landlord?: Landlord | null;
}

export interface LeaseEscalation {
  id: string;
  lease_id: string;
  effective_date: string;
  previous_amount: number;
  new_amount: number;
  escalation_type: string;
  escalation_value?: number | null;
  status: LeaseEscalationStatus;
  applied_by?: string | null;
  applied_at?: string | null;
  notes?: string | null;
  created_at: string;
  applied_by_name?: string | null;
}

export interface LeasePayment {
  id: string;
  lease_id: string;
  payment_month: string;
  due_date: string;
  paid_date?: string | null;
  gross_rent_amount: number;
  tds_amount: number;
  net_amount_paid?: number | null;
  payment_mode?: LeasePaymentMode | null;
  payment_reference?: string | null;
  bank_account_id?: string | null;
  status: LeasePaymentStatus;
  auto_approved: boolean;
  approved_by?: string | null;
  approved_at?: string | null;
  on_hold_reason?: string | null;
  attachment_url?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  approved_by_name?: string | null;
  bank_account?: LandlordBankAccount | null;
}

export interface LeaseAsset {
  id: string;
  lease_id: string;
  asset_name: string;
  asset_category?: AssetCategory | null;
  serial_number?: string | null;
  make_model?: string | null;
  quantity: number;
  unit_value: number;
  is_capex: boolean;
  condition_at_takeover?: AssetCondition | null;
  notes?: string | null;
  created_at: string;
}

export interface LeaseAssetHandover {
  id: string;
  lease_id: string;
  handover_type: LeaseHandoverType;
  handover_date: string;
  completed_by?: string | null;
  landlord_representative?: string | null;
  witness_name?: string | null;
  status: LeaseHandoverStatus;
  notes?: string | null;
  before_photos: string[];
  after_photos: string[];
  asset_conditions: { asset_id: string; condition: string; notes?: string }[];
  created_at: string;
  updated_at: string;
  completed_by_name?: string | null;
}

export interface LeaseDocument {
  id: string;
  lease_id: string;
  document_type: LeaseDocumentType;
  document_name: string;
  file_url: string;
  file_size?: number | null;
  mime_type?: string | null;
  version: number;
  description?: string | null;
  uploaded_by?: string | null;
  created_at: string;
  uploaded_by_name?: string | null;
}

export interface LeaseServiceOffering {
  id: string;
  lease_id: string;
  service_name: LeaseServiceName;
  custom_service_name?: string | null;
  landlord_provided: boolean;
  responsible?: string | null;
  accountable?: string | null;
  consulted?: string | null;
  informed?: string | null;
  frequency?: string | null;
  sla_notes?: string | null;
  created_at: string;
  updated_at: string;
}

// ── Payroll ───────────────────────────────────────────────────────────────────

export interface Employee {
  id: string;
  location_id: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  department: string | null;
  designation: string | null;
  cosec_ref_id: number | null;
  nfc_card_number: string | null;
  is_active: boolean;
  notes: string | null;
  date_of_joining: string | null;
  employment_type: "full_time" | "part_time" | "intern";
  pan_number: string | null;
  created_at: string;
  updated_at: string;
  location?: { id: string; name: string } | null;
}

export interface SalaryDefinition {
  id: string;
  employee_id: string;
  effective_from: string;
  basic: number;
  hra: number;
  da: number;
  special_allowance: number;
  lta_annual: number;
  mobile_reimbursement: number;
  other_reimbursements: number;
  tds_applicable: boolean;
  tds_monthly_amount: number;
  pan_number: string | null;
  pf_applicable: boolean;
  esi_applicable: boolean;
  created_at: string;
  updated_at: string;
}

export interface LeavePolicy {
  id: string;
  policy_year: number;
  cl_days_per_year: number;
  sl_days_per_year: number;
  lop_tracked: boolean;
  created_at: string;
}

export interface LeaveBalance {
  id: string;
  employee_id: string;
  policy_year: number;
  cl_total: number;
  cl_used: number;
  sl_total: number;
  sl_used: number;
  lop_days: number;
  updated_at: string;
  // Computed in application
  cl_balance?: number;
  sl_balance?: number;
}

export interface LeaveRequest {
  id: string;
  employee_id: string;
  leave_type: "cl" | "sl" | "lop";
  from_date: string;
  to_date: string;
  days_count: number;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  employee?: Pick<Employee, "id" | "full_name" | "department" | "designation">;
  reviewer?: { id: string; full_name: string } | null;
}

export interface PayrollRun {
  id: string;
  run_month: string;           // YYYY-MM-DD (1st of month)
  status: "draft" | "finalized";
  total_gross: number;
  total_deductions: number;
  total_net: number;
  employee_count: number;
  finalized_by: string | null;
  finalized_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  finalizer?: { id: string; full_name: string } | null;
}

export interface PayrollSlip {
  id: string;
  payroll_run_id: string;
  employee_id: string;
  employee_name: string;
  department: string | null;
  designation: string | null;
  working_days: number;
  days_present: number;
  cl_days: number;
  sl_days: number;
  lop_days: number;
  basic: number;
  hra: number;
  da: number;
  special_allowance: number;
  mobile_reimbursement: number;
  other_reimbursements: number;
  lta_this_month: number;
  gross_payable: number;
  lop_deduction: number;
  pt_deduction: number;
  tds_deduction: number;
  pf_employee: number;
  esi_employee: number;
  other_deductions: number;
  total_deductions: number;
  net_payable: number;
  is_locked: boolean;
  override_note: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Electricity Sub-Billing
// ============================================================

export type ElectricityBillStatus = 'draft' | 'invoiced' | 'revised';
export type ElectricityLineType = 'utility' | 'generator' | 'other';
export type ElectricityMarkupType = 'per_unit' | 'percent';

export interface LocationElectricityConfig {
  id: string;
  location_id: string;
  enabled: boolean;
  reimbursement_enabled: boolean;
  service_number: string | null;
  landlord_vendor_id: string | null;
  landlord_utility_rate: number;
  landlord_utility_pct: number;
  landlord_generator_pct: number;
  landlord_generator_rate: number;
  bill_due_day_of_month: number;
  landlord_gst_applicable: boolean;
  landlord_gst_rate: number | null;
  tds_section: string | null;
  tds_rate: number | null;
  onegrid_enabled: boolean;
  onegrid_api_key: string | null;
  onegrid_default_device_id: string | null;
  // Deprecated: customer settings moved to contract_electricity_config
  customer_utility_pct: number;
  customer_generator_pct: number;
  markup_type: ElectricityMarkupType;
  markup_value: number;
  customer_generator_rate: number;
  created_at: string;
  updated_at: string;
}

export interface ElectricityBillLine {
  id: string;
  electricity_bill_id: string;
  line_type: ElectricityLineType;
  meter_label: string | null;
  units: number | null;
  rate: number | null;
  amount: number;
  label: string | null;
  sort_order: number;
  created_at: string;
}

export interface ElectricityBill {
  id: string;
  location_id: string;
  contract_id: string | null;
  bill_side: "landlord" | "customer";
  landlord_bill_id: string | null;
  bill_month: number;
  bill_year: number;
  landlord_bill_number: string | null;
  landlord_bill_date: string | null;
  landlord_total_amount: number;
  attachment_path: string | null;
  reimbursement_enabled: boolean;
  landlord_utility_pct: number;
  landlord_generator_pct: number;
  customer_utility_pct: number | null;
  customer_generator_pct: number | null;
  customer_units_billed: number | null;
  customer_units_overridden: boolean;
  customer_markup_type: ElectricityMarkupType | null;
  customer_markup_value: number | null;
  customer_utility_rate: number | null;
  customer_generator_rate: number | null;
  customer_subtotal: number | null;
  customer_cgst: number | null;
  customer_sgst: number | null;
  customer_total: number | null;
  customer_round_off: number | null;
  gst_rate: number;
  status: ElectricityBillStatus;
  vendor_bill_id: string | null;
  billing_statement_id: string | null;
  revised_from_id: string | null;
  created_by: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  lines?: ElectricityBillLine[];
}

export interface ContractElectricitySettings {
  customer_utility_pct?: number;
  customer_generator_pct?: number;
  markup_type?: ElectricityMarkupType;
  markup_value?: number;
  customer_generator_rate?: number;
  gst_rate?: number;
}

export interface ContractElectricityConfig {
  id: string;
  contract_id: string;
  location_id: string;
  enabled: boolean;
  utility_ratio: number;
  generator_ratio: number;
  customer_utility_rate: number;
  customer_generator_rate: number;
  customer_gst_rate: number;
  created_at: string;
  updated_at: string;
}

export type MoratoriumStatus = "pending" | "approved" | "rejected";

export interface ContractBillingMoratorium {
  id: string;
  contract_id: string;
  moratorium_month: string; // "YYYY-MM-DD" (first of month)
  reason: string;
  status: MoratoriumStatus;
  requested_by: string | null;
  requested_at: string;
  authorized_by: string | null;
  authorized_at: string | null;
  authorization_note: string | null;
  overridden_at: string | null;
  overridden_by: string | null;
  created_at: string;
  updated_at: string;
  // joined
  requested_by_user?: { full_name: string } | null;
  authorized_by_user?: { full_name: string } | null;
}


/**
 * One entry on a billing statement's unified history timeline.
 *
 * Built by GET /api/billing-statements/[id]/timeline, which merges six
 * sources (lifecycle columns, send log, reminder sends, payments, GST
 * uploads, audit trail) into a single chronological narrative. Prior to
 * this the AR page only ever showed send events, so workflow overrides
 * like "PI cancelled, GST issued early" were invisible — a GST invoice
 * would appear against an unpaid bill with no visible explanation.
 */
export type StatementTimelineKind =
  | "lifecycle"
  | "send"
  | "reminder"
  | "payment"
  | "payment_report"
  | "gst"
  | "audit";

export interface StatementTimelineEvent {
  id: string;
  at: string;
  kind: StatementTimelineKind;
  label: string;
  detail: string | null;
  channel: string | null;
  recipient: string | null;
  /** sent | delivered | opened | failed | ok */
  status: string | null;
  error: string | null;
  /** Resolved display name, or a sentinel like "Cron" / "System". */
  actor: string | null;
  amount: number | null;
  /** Draws the eye to workflow overrides that explain otherwise-odd state. */
  highlight: boolean;
}

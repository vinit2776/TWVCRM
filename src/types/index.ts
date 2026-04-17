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
  created_at: string;
  updated_at: string;
}

// ==========================================
// User Types
// ==========================================
export type UserRole = "admin" | "manager" | "sales_rep" | "floor_manager" | "accounts" | "fms" | "office_admin";

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
  | "lost";

export type LeadSource =
  | "meta_ads"
  | "google_ads"
  | "direct_walkin"
  | "online_form"
  | "referral"
  | "social_media"
  | "advertisement"
  | "cold_call"
  | "event"
  | "partner"
  | "other";

export type WorkspaceType =
  | "hot_desk"
  | "dedicated_desk"
  | "private_office"
  | "meeting_room"
  | "conference_room"
  | "virtual_office";

export type Rating = "none" | "hot" | "warm" | "cold";

export interface Lead {
  id: string;
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
  created_by?: string;
  created_at: string;
  updated_at: string;
  occupation_start_date?: string;
  // Payment tracking (Razorpay)
  payment_status?: string; // "pending" | "paid"
  razorpay_payment_link_id?: string;
  razorpay_payment_link_url?: string;
  payment_received_at?: string;
  payment_amount?: number;
  payment_reference?: string;
  // Security deposit
  security_deposit_months?: number;
  security_deposit_amount?: number;
  deposit_payment_status?: string; // "not_required" | "pending" | "paid"
  deposit_razorpay_link_id?: string;
  deposit_razorpay_link_url?: string;
  deposit_payment_received_at?: string;
  deposit_payment_amount?: number;
  deposit_payment_reference?: string;
  deposit_payment_screenshot_url?: string;
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
  notes?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
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
  | "renewed"
  | "expired"
  | "terminated";

export type BillingCycle =
  | "monthly"
  | "quarterly"
  | "half_yearly"
  | "yearly";

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
  tenure_months: number;
  start_date: string;
  end_date: string;
  next_billing_date?: string;
  seats: number;
  terms_and_conditions?: string;
  notes?: string;
  // Membership agreement fields
  workspace_description?: string;
  parking_space?: string;
  complimentary_services?: string;
  security_deposit_months?: number;
  escalation_percentage?: number;
  notice_period_months?: number;
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
  signed_document_id?: string;
  signed_document?: CrmDocument;
  printer_department_id?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
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
export type BillingStatementStatus = "draft" | "finalized" | "exported";

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
}

// ==========================================
// Audit Log Types
// ==========================================
export type AuditAction = "create" | "update" | "delete" | "login";
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
  | "consumption_log";

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
// Space Types
// ==========================================
export interface SpaceOperatingDay {
  open: string;
  close: string;
  is_open: boolean;
}

export type SpaceOperatingHours = Record<string, SpaceOperatingDay>;

export interface Space {
  id: string;
  name: string;
  location_id: string;
  location?: Location;
  capacity: number;
  hourly_rate: number;
  description?: string;
  workspace_type?: WorkspaceType;
  operating_hours: SpaceOperatingHours;
  max_advance_booking_days: number;
  min_booking_minutes: number;
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
  // Razorpay Payment Links
  razorpay_payment_link_id?: string;
  razorpay_payment_link_url?: string;
  // Prepaid package redemption
  prepaid_purchase_id?: string;
  prepaid_credits_used?: number;
  prepaid_topup_amount?: number;
  notes?: string;
  aggregator_booking_id?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  facilities?: BookingFacility[];
  feedback?: BookingFeedback | null;          // staff rating (backward compat)
  customer_feedback?: BookingFeedback | null; // customer-submitted via link
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
  created_at: string;
  updated_at: string;
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
  conversion: { total_leads: number; won: number; lost: number; rate: number };
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
export type CaseStatus =
  | "intake_received" | "docs_requested" | "docs_received" | "under_review"
  | "compliance_check" | "internal_approved" | "sent_for_client_approval"
  | "client_approved" | "signing_in_progress" | "executed"
  | "invoiced" | "active" | "renewal_due" | "renewed" | "lapsed";

export type CaseDocStatus = "pending" | "uploaded" | "approved" | "rejected";

export type ComplianceCheckStatus = "pending" | "passed" | "failed" | "waived";

export type AgreementStatus =
  | "draft" | "pending_internal_approval" | "internally_approved"
  | "sent_to_client" | "client_approved" | "signing" | "executed" | "expired";

export type EmailDirection = "inbound" | "outbound";

export type AggInvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled";

export interface VoCase {
  id: string;
  case_number: string;
  aggregator_id: string;
  aggregator?: Aggregator;
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
  status: CaseDocStatus; // reuse same enum: pending, uploaded, approved, rejected
  reviewed_by?: string;
  reviewer?: User;
  reviewed_at?: string;
  rejection_reason?: string;
  notes?: string;
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

export interface AggregatorInvoice {
  id: string;
  invoice_number: string;
  aggregator_id: string;
  aggregator?: Aggregator;
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

export type ProcurementDepartment = "pantry" | "maintenance" | "administration" | "asset";
export type VendorCategory = "pantry" | "maintenance" | "administration" | "general";
export type ItemUnit = "kg" | "litre" | "packet" | "box" | "piece" | "roll" | "dozen" | "bottle" | "bag" | "set" | "pair" | "month" | "quarter" | "year" | "nos" | "can" | "ton";
export type PrStatus = "draft" | "submitted" | "approved" | "rejected" | "partially_ordered" | "po_created" | "cancelled";
export type PoStatus = "pending" | "ordered" | "partially_received" | "received" | "invoice_received" | "invoice_approved" | "cancelled" | "partially_cancelled";
export type BillPaymentStatus = "unpaid" | "partially_paid" | "paid";
export type BillApprovalStatus = "pending" | "approved" | "rejected";
export type RejectionOutcome = "return" | "replacement" | "void";

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
  is_active: boolean;
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
  // Joined fields
  locations?: { id: string; name: string } | null;
  requester?: { id: string; full_name?: string; email?: string } | null;
  approver?: { id: string; full_name?: string; email?: string } | null;
  purchase_request_items?: PurchaseRequestItem[];
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

export type AmcStatus = "inactive" | "active" | "expiring" | "exhausted" | "expired";
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
  approved_amount?: number | null;
  approved_amount_note?: string | null;
  rejection_reason?: string;
  rejection_outcome?: RejectionOutcome;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  procurement_vendors?: Pick<ProcurementVendor, "id" | "name"> | null;
  purchase_orders?: Pick<PurchaseOrder, "id" | "po_number" | "po_type"> | null;
  approver?: { id: string; full_name?: string } | null;
  vendor_bill_payments?: Array<{
    id: string; amount: number; payment_mode: string;
    payment_reference: string | null; payment_date: string;
    notes: string | null;
    recorder: { id: string; full_name: string } | null;
  }>;
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
  procurement_items?: { id: string; name: string; department: string; unit: string; item_type: string } | null;
}

export interface StockTransferItem {
  id: string;
  transfer_id: string;
  item_id?: string;
  item_name: string;
  unit: string;
  quantity_sent: number;
  quantity_received: number;
  notes?: string;
  procurement_items?: { id: string; name: string } | null;
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
  initiated_by: string;
  approved_by?: string;
  approved_at?: string;
  dispatched_at?: string;
  received_by?: string;
  received_at?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  from_location?: { id: string; name: string; code: string } | null;
  to_location?: { id: string; name: string; code: string } | null;
  initiator?: { id: string; full_name?: string } | null;
  approver?: { id: string; full_name?: string } | null;
  receiver?: { id: string; full_name?: string } | null;
  stock_transfer_items?: StockTransferItem[];
  stock_transfer_issues?: StockTransferIssue[];
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
}

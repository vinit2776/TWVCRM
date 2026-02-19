// ==========================================
// Location Types
// ==========================================
export interface Location {
  id: string;
  name: string;
  code: string;
  address?: string;
  city?: string;
  state?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ==========================================
// User Types
// ==========================================
export type UserRole = "admin" | "manager" | "sales_rep" | "floor_manager";

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
  created_by?: string;
  creator?: User;
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
  unit_price: number;
  total: number;
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
  created_by?: string;
  created_at: string;
  updated_at: string;
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
  agreement_date?: string;
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
  created_by?: string;
  created_at: string;
  updated_at: string;
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
  | "booking";

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
  operating_hours: SpaceOperatingHours;
  max_advance_booking_days: number;
  min_booking_minutes: number;
  cancellation_policy?: string;
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
export type BookingPaymentStatus = "pending" | "paid" | "waived" | "posted_to_bill";

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
  notes?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  facilities?: BookingFacility[];
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
export interface DashboardStats {
  pipeline: { status: LeadStatus; count: number }[];
  tasks_due_today: number;
  tasks_overdue: number;
  recent_activities: Activity[];
  conversion: { total_leads: number; won: number; lost: number; rate: number };
  pending_follow_ups: number;
}

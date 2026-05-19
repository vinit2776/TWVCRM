export const APP_NAME = "TWV CRM";

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "tour_scheduled",
  "tour_completed",
  "proposal_sent",
  "negotiating",
  "won",
  "lost",
] as const;

export const LEAD_STATUS_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  tour_scheduled: "Tour Scheduled",
  tour_completed: "Tour Completed",
  proposal_sent: "Proposal Sent",
  negotiating: "Negotiating",
  won: "Won",
  lost: "Lost",
};

export const LEAD_STATUS_COLORS: Record<string, string> = {
  new: "bg-gray-100 text-gray-800",
  contacted: "bg-blue-100 text-blue-800",
  tour_scheduled: "bg-purple-100 text-purple-800",
  tour_completed: "bg-indigo-100 text-indigo-800",
  proposal_sent: "bg-yellow-100 text-yellow-800",
  negotiating: "bg-orange-100 text-orange-800",
  won: "bg-green-100 text-green-800",
  lost: "bg-red-100 text-red-800",
};

export const LEAD_SOURCES = [
  "meta_ads",
  "google_ads",
  "direct_walkin",
  "online_form",
  "referral",
  "social_media",
  "advertisement",
  "cold_call",
  "event",
  "partner",
  "other",
] as const;

export const LEAD_SOURCE_LABELS: Record<string, string> = {
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  direct_walkin: "Direct/Walk-in",
  online_form: "Online Form",
  referral: "Referral",
  social_media: "Social Media",
  advertisement: "Advertisement",
  cold_call: "Cold Call",
  event: "Event",
  partner: "Partner",
  other: "Other",
};

export const WORKSPACE_TYPES = [
  "hot_desk",
  "dedicated_desk",
  "private_office",
  "meeting_room",
  "conference_room",
  "virtual_office",
] as const;

export const WORKSPACE_TYPE_LABELS: Record<string, string> = {
  hot_desk: "Hot Desk",
  dedicated_desk: "Dedicated Desk",
  private_office: "Private Office/Cabin",
  meeting_room: "Meeting Room",
  conference_room: "Conference Room",
  virtual_office: "Virtual Office",
};

export const ACTIVITY_TYPES = ["call", "meeting", "note", "email", "tour"] as const;

export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  call: "Call",
  meeting: "Meeting",
  note: "Note",
  email: "Email",
  tour: "Tour",
};

export const CALL_OUTCOMES = [
  "connected",
  "no_answer",
  "voicemail",
  "busy",
  "wrong_number",
  "callback_scheduled",
] as const;

export const CALL_OUTCOME_LABELS: Record<string, string> = {
  connected: "Connected",
  no_answer: "No Answer",
  voicemail: "Voicemail",
  busy: "Busy",
  wrong_number: "Wrong Number",
  callback_scheduled: "Callback Scheduled",
};

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;

export const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};

export const TASK_STATUS_COLORS: Record<string, string> = {
  todo: "bg-gray-100 text-gray-800",
  in_progress: "bg-blue-100 text-blue-800",
  done: "bg-green-100 text-green-800",
};

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const TASK_PRIORITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const TASK_PRIORITY_COLORS: Record<string, string> = {
  low: "bg-gray-100 text-gray-600",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

export const PROPOSAL_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "accepted",
  "rejected",
  "expired",
] as const;

export const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
};

export const PROPOSAL_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  sent: "bg-blue-100 text-blue-800",
  viewed: "bg-purple-100 text-purple-800",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  expired: "bg-orange-100 text-orange-800",
};

export const INVOICE_STATUSES = ["draft", "sent", "paid", "overdue", "cancelled"] as const;

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

export const USER_ROLES = ["admin", "manager", "sales_rep", "floor_manager", "accounts", "fms", "office_admin"] as const;

export const USER_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  sales_rep: "Sales Rep",
  floor_manager: "Floor Incharge",
  accounts: "Accounts",
  fms: "Facility Manager",
  office_admin: "Office Administrator",
  it_team: "IT Team",
};

export const RATINGS = ["none", "hot", "warm", "cold"] as const;

export const RATING_LABELS: Record<string, string> = {
  none: "None",
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
};

export const LEAD_SCORES = [0, 25, 50, 75, 100] as const;

export const LEAD_SCORE_LABELS: Record<number, string> = {
  0: "Not Scored",
  25: "Cold — Low interest / early stage",
  50: "Warm — Some interest shown",
  75: "Hot — Strong interest, likely to convert",
  100: "Very Hot — Ready to close",
};

export const LEAD_SCORE_SHORT_LABELS: Record<number, string> = {
  0: "Not Scored",
  25: "Cold",
  50: "Warm",
  75: "Hot",
  100: "Very Hot",
};

// ==========================================
// Contract Constants
// ==========================================
export const CONTRACT_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "accepted",
  "rejected",
  "active",
  "renewal_in_progress",
  "renewed",
  "expired",
  "terminated",
] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

// Contracts in these statuses are "locked": only admin may edit quotas/facilities.
// Mirrors the API gate in /api/contracts/[id]/facilities and /quotas.
export const CONTRACT_QUOTA_LOCKED_STATUSES: readonly ContractStatus[] = [
  "active",
  "renewal_in_progress",
  "renewed",
  "terminated",
  "expired",
];

// Roles that may ever edit contract quotas/facilities.
// On locked contracts (active+), only admin is allowed (enforced by API gate).
// On draft/sent/accepted contracts, all four roles can configure quotas.
export const CONTRACT_QUOTA_ROLES = ["admin", "manager", "sales_rep", "accounts"] as const;
export type ContractQuotaRole = (typeof CONTRACT_QUOTA_ROLES)[number];

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  rejected: "Rejected",
  active: "Active",
  renewal_in_progress: "Renewal in Progress",
  renewed: "Renewed",
  expired: "Expired",
  terminated: "Terminated",
};

export const CONTRACT_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  sent: "bg-blue-100 text-blue-800",
  viewed: "bg-purple-100 text-purple-800",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  active: "bg-emerald-100 text-emerald-800",
  renewal_in_progress: "bg-amber-100 text-amber-800",
  renewed: "bg-blue-100 text-blue-800",
  expired: "bg-orange-100 text-orange-800",
  terminated: "bg-red-100 text-red-800",
};

// Valid status transitions for the contract state machine.
// Mirrors the CASE_STATUS_TRANSITIONS pattern. Used by the PATCH
// handler to prevent invalid jumps (e.g. terminated → active).
// The renew endpoint sets renewal_in_progress directly (not via PATCH),
// so active→renewal_in_progress is allowed but guarded by the renew API.
/**
 * Contract lifecycle state machine.
 *
 * Forward-only: Draft → Sent → Viewed → Accepted → Active → terminal.
 * No backward transitions allowed (e.g. active → draft) to prevent
 * accidental reactivation that would trigger billing generation.
 *
 * Special paths:
 *   - `rejected` can only be reached from sent/viewed/accepted;
 *     a rejected contract can be cloned into a new draft.
 *   - `draft → active` is intentionally removed — contracts must go
 *     through sent → viewed/accepted first to ensure the customer
 *     has seen and agreed to the terms.
 */
export const CONTRACT_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft:                 ["sent", "terminated"],
  sent:                  ["viewed", "accepted", "rejected"],
  viewed:                ["accepted", "rejected"],
  accepted:              ["active", "rejected"],
  rejected:              [],           // terminal — clone to new draft instead
  active:                ["renewal_in_progress", "expired", "terminated"],
  renewal_in_progress:   ["renewed", "active", "terminated"],
  renewed:               [],           // terminal — source contract
  expired:               ["renewal_in_progress", "terminated"],
  terminated:            [],           // terminal
};

export const BILLING_CYCLES = [
  "monthly",
  "quarterly",
  "half_yearly",
  "yearly",
] as const;

export const BILLING_CYCLE_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-Yearly",
  yearly: "Yearly",
};

export const BILLING_CYCLE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
};

// ==========================================
// Voucher Constants
// ==========================================
export const VOUCHER_STATUSES = [
  "available",
  "issued",
  "expired",
  "revoked",
] as const;

export const VOUCHER_STATUS_LABELS: Record<string, string> = {
  available: "Available",
  issued: "Issued",
  expired: "Expired",
  revoked: "Revoked",
};

export const VOUCHER_STATUS_COLORS: Record<string, string> = {
  available: "bg-green-100 text-green-800",
  issued: "bg-blue-100 text-blue-800",
  expired: "bg-orange-100 text-orange-800",
  revoked: "bg-red-100 text-red-800",
};

export const VOUCHER_VALIDITY_OPTIONS = [0.125, 1, 7, 30, 60, 90, 180, 365] as const;

export const VOUCHER_VALIDITY_LABELS: Record<number, string> = {
  0.125: "3 Hours",
  1: "1 Day",
  7: "7 Days",
  30: "30 Days",
  60: "60 Days",
  90: "90 Days",
  180: "180 Days",
  365: "365 Days",
};

export const VOUCHER_LOW_STOCK_THRESHOLD = 10;

// ==========================================
// OTP Configuration
// ==========================================
export const OTP_EXPIRY_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;

// ==========================================
// Usage Charge Constants
// ==========================================
export const USAGE_CHARGE_STATUSES = ["pending", "billed", "waived"] as const;

export const USAGE_CHARGE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  billed: "Billed",
  waived: "Waived",
};

export const USAGE_CHARGE_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  billed: "bg-green-100 text-green-800",
  waived: "bg-gray-100 text-gray-800",
};

// ==========================================
// Billing Statement Constants
// ==========================================
export const BILLING_STATEMENT_STATUSES = [
  "draft",
  "finalized",
  "exported",
] as const;

export const BILLING_STATEMENT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  finalized: "Finalized",
  exported: "Exported",
};

export const BILLING_STATEMENT_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  finalized: "bg-blue-100 text-blue-800",
  exported: "bg-green-100 text-green-800",
};

// ==========================================
// Default Terms & Conditions
// ==========================================
export const DEFAULT_PROPOSAL_TERMS = `• Taxes as applicable
• 3 months rent payable as an interest free refundable security deposit
• Advance monthly rent payable on or before 5th of every month
• Term 1 year (Lock-in 11 months)
• Notice period 2 months post lock-in
• Center timing Monday - Saturday 9AM to 7PM
• This proposal is valid upto 10 days only from the date of issue.`;

// ==========================================
// Company Bank Details
// ==========================================
export const COMPANY_BANK_DETAILS = {
  accountName: "Sree Design Infrastructure Private Limited",
  accountNumber: "000905000140",
  ifscCode: "ICIC0000009",
  bank: "ICICI Bank Ltd",
  branch: "Nungambakkam",
};

export const DOCUMENT_CATEGORIES = [
  "contract",
  "identity",
  "proposal",
  "invoice",
  "general",
] as const;

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ==========================================
// Booking Constants
// ==========================================
export const BOOKING_STATUSES = [
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
] as const;

export const BOOKING_STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  checked_in: "Checked In",
  checked_out: "Checked Out",
  cancelled: "Cancelled",
  no_show: "No Show",
};

export const BOOKING_STATUS_COLORS: Record<string, string> = {
  confirmed: "bg-blue-100 text-blue-800",
  checked_in: "bg-green-100 text-green-800",
  checked_out: "bg-gray-100 text-gray-800",
  cancelled: "bg-red-100 text-red-800",
  no_show: "bg-orange-100 text-orange-800",
};

// Cancellation reason picklist — locked taxonomy. The "suspected_fake_
// booking" value triggers an auto-prefilled danger-severity caution on
// the lead so future staff get a loud warning. "other" requires staff
// to fill the details field.
export const BOOKING_CANCELLATION_REASONS = [
  "customer_requested",
  "no_show",
  "overbooking_error",
  "suspected_fake_booking",
  "centre_operational_issue",
  "other",
] as const;

export const BOOKING_CANCELLATION_REASON_LABELS: Record<string, string> = {
  customer_requested:        "Customer requested",
  no_show:                   "No-show / didn't arrive",
  overbooking_error:         "Overbooking error",
  suspected_fake_booking:    "Suspected fake booking",
  centre_operational_issue:  "Centre operational issue",
  other:                     "Other (please specify)",
};

// Lead caution severity — drives the colour and the new-booking gate.
// danger requires explicit acknowledgement before staff can proceed.
export const LEAD_CAUTION_SEVERITY_LABELS: Record<string, string> = {
  info:    "Info",
  warning: "Warning",
  danger:  "Danger",
};

export const LEAD_CAUTION_SEVERITY_COLORS: Record<string, string> = {
  info:    "bg-slate-100 text-slate-700 border-slate-300",
  warning: "bg-amber-50 text-amber-800 border-amber-300",
  danger:  "bg-red-50 text-red-800 border-red-400",
};

// Refund request reason picklist — used by the cancel dialog when
// payment was collected and the cancellation qualifies for refund.
export const REFUND_REQUEST_REASON_LABELS: Record<string, string> = {
  centre_at_fault:       "Centre at fault",
  within_policy_window:  "Cancelled within policy window",
  goodwill:              "Goodwill gesture",
  other:                 "Other (please specify)",
};

export const REFUND_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending_approval:  "Pending approval",
  approved:          "Approved — awaiting refund",
  rejected:          "Rejected",
  processed:         "Refund processed",
};

export const REFUND_REQUEST_STATUS_COLORS: Record<string, string> = {
  pending_approval:  "bg-amber-100 text-amber-800",
  approved:          "bg-blue-100 text-blue-800",
  rejected:          "bg-red-100 text-red-800",
  processed:         "bg-green-100 text-green-800",
};

// Complimentary booking reasons — locked picklist used both at booking
// creation (when total = 0) and the post-hoc "Mark as Complimentary"
// action. Captures intent for finance / management analytics.
export const BOOKING_COMPLIMENTARY_REASONS = [
  "manager_goodwill",
  "aggregator_demo",
  "staff_use",
  "event_partnership",
  "other",
] as const;

export const BOOKING_COMPLIMENTARY_REASON_LABELS: Record<string, string> = {
  manager_goodwill:   "Manager goodwill (VIP / disgruntled customer / influencer)",
  aggregator_demo:    "Aggregator demo / evaluation slot",
  staff_use:          "Staff use (training / internal trial)",
  event_partnership:  "Event partnership / sponsorship",
  other:              "Other (please specify)",
};

export const BOOKING_CUSTOMER_TYPES = [
  "contract_holder",
  "walk_in",
  "guest",
] as const;

export const BOOKING_CUSTOMER_TYPE_LABELS: Record<string, string> = {
  contract_holder: "Contract Holder",
  walk_in: "Walk-in",
  guest: "Guest",
};

export const BOOKING_CUSTOMER_TYPE_COLORS: Record<string, string> = {
  contract_holder: "bg-emerald-100 text-emerald-800",
  walk_in: "bg-purple-100 text-purple-800",
  guest: "bg-cyan-100 text-cyan-800",
};

export const BOOKING_PAYMENT_STATUSES = [
  "pending",
  "paid",
  "waived",
  "posted_to_bill",
  "prepaid",
] as const;

/**
 * Customer-facing labels for booking.payment_status. Finance feedback was
 * that "Posted to Bill" felt like jargon — it's the clearest one-word
 * summary, but the booking detail UI now augments these with context
 * (which contract, which month, free-quota math, etc).
 */
export const BOOKING_PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pending Collection",
  paid: "Paid",
  waived: "Waived",
  posted_to_bill: "Post-paid (Monthly Invoice)",
  prepaid: "Prepaid Pack",
};

export const BOOKING_PAYMENT_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  paid: "bg-green-100 text-green-800",
  waived: "bg-gray-100 text-gray-800",
  posted_to_bill: "bg-blue-100 text-blue-800",
  prepaid: "bg-purple-100 text-purple-800",
};

export const PAYMENT_MODES = ["upi", "cash", "card", "online"] as const;

export const PAYMENT_MODE_LABELS: Record<string, string> = {
  upi: "UPI",
  cash: "Cash",
  card: "Card",
  online: "Online",
};

// ==========================================
// Booking Feedback Dimensions
// ==========================================
export const FEEDBACK_DIMENSIONS = [
  { key: "space_etiquette", label: "Space Etiquette", description: "Noise levels, cleanliness, respecting quiet zones" },
  { key: "payment_discipline", label: "Payment Discipline", description: "On-time payments, no bounced transactions" },
  { key: "community_behavior", label: "Community Behavior", description: "Respectful to other members, positive participation" },
  { key: "guest_management", label: "Guest Management", description: "Follows visitor policies, no overcrowding" },
  { key: "resource_usage", label: "Resource Usage", description: "Fair use of meeting rooms and amenities" },
  { key: "renewal_likelihood", label: "Renewal Likelihood", description: "Gut feel on retention probability" },
] as const;

export const DEFAULT_FACILITIES = [
  "Projector",
  "Whiteboard",
  "Video Conferencing",
  "Stationery",
  "Printer Access",
  "Coffee/Tea",
  "Water",
  "WiFi",
] as const;

// ==========================================
// Booking Payment Record Constants
// ==========================================
export const BOOKING_PAYMENT_MODES = ["cash", "upi", "card", "razorpay"] as const;

export const BOOKING_PAYMENT_MODE_LABELS: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  razorpay: "Pay Online (Razorpay)",
};

export const BOOKING_PAYMENT_RECORD_STATUSES = ["pending", "verified", "rejected"] as const;

export const BOOKING_PAYMENT_RECORD_STATUS_LABELS: Record<string, string> = {
  pending: "Pending Verification",
  verified: "Verified",
  rejected: "Rejected",
};

export const BOOKING_PAYMENT_RECORD_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  verified: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

// ==========================================
// Accounting Module Constants
// ==========================================

export const ACCOUNTING_PERIOD_STATUSES = ["open", "locked"] as const;

export const ACCOUNTING_PERIOD_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  locked: "Locked",
};

export const ACCOUNTING_PERIOD_STATUS_COLORS: Record<string, string> = {
  open: "bg-green-100 text-green-800",
  locked: "bg-red-100 text-red-800",
};

export const CASH_HANDOVER_STATUSES = ["pending_handover", "handed_over"] as const;

export const CASH_HANDOVER_STATUS_LABELS: Record<string, string> = {
  pending_handover: "Pending Handover",
  handed_over: "Handed Over",
};

export const CASH_HANDOVER_STATUS_COLORS: Record<string, string> = {
  pending_handover: "bg-yellow-100 text-yellow-800",
  handed_over: "bg-green-100 text-green-800",
};

export const CONTRACT_PAYMENT_MODES = ["cash", "upi", "card", "bank_transfer", "razorpay"] as const;

export const CONTRACT_PAYMENT_MODE_LABELS: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  bank_transfer: "Bank Transfer",
  razorpay: "Razorpay",
};

export const CONTRACT_PAYMENT_STATUSES = ["pending", "verified", "rejected"] as const;

export const CONTRACT_PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  verified: "Verified",
  rejected: "Rejected",
};

export const CONTRACT_PAYMENT_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  verified: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export const GST_INVOICE_STATUSES = [null, "invoiced", "sent"] as const;

export const GST_INVOICE_STATUS_LABELS: Record<string, string> = {
  "": "No Invoice",
  invoiced: "Invoiced",
  sent: "Sent",
};

export const GST_INVOICE_STATUS_COLORS: Record<string, string> = {
  "": "bg-gray-100 text-gray-800",
  invoiced: "bg-blue-100 text-blue-800",
  sent: "bg-green-100 text-green-800",
};

export const MONTH_NAMES = [
  "January", "February", "March", "April",
  "May", "June", "July", "August",
  "September", "October", "November", "December",
] as const;

// ==========================================
// Recurring Booking Constants
// ==========================================
export const RECURRENCE_FREQUENCIES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;

// ==========================================
// Waitlist Constants
// ==========================================
export const WAITLIST_STATUSES = ["waiting", "offered", "booked", "expired", "cancelled"] as const;

export const WAITLIST_STATUS_LABELS: Record<string, string> = {
  waiting: "Waiting",
  offered: "Slot Offered",
  booked: "Converted to Booking",
  expired: "Expired",
  cancelled: "Cancelled",
};

export const WAITLIST_STATUS_COLORS: Record<string, string> = {
  waiting: "bg-yellow-100 text-yellow-800",
  offered: "bg-blue-100 text-blue-800",
  booked: "bg-green-100 text-green-800",
  expired: "bg-gray-100 text-gray-800",
  cancelled: "bg-red-100 text-red-800",
};

// ==========================================
// Booking Notes Templates
// ==========================================
export const BOOKING_NOTE_TEMPLATES = [
  "Extra chairs requested",
  "Projector setup needed",
  "Catering ordered",
  "VIP client — ensure room is spotless",
  "Late arrival expected",
  "External guests attending",
] as const;

// ==========================================
// Customer Segmentation
// ==========================================
export const CUSTOMER_SEGMENTS = {
  frequent: { label: "Frequent Visitors", threshold: 5, description: "5+ bookings in last 90 days" },
  lapsed: { label: "Lapsed Customers", days: 60, description: "No bookings in 60+ days" },
  high_spender: { label: "High Spenders", description: "Top 20% by total spend" },
  low_feedback: { label: "Low Feedback", threshold: 2.5, description: "Average rating below 2.5" },
} as const;

// ==========================================
// Aggregator Constants
// ==========================================
export const AGGREGATOR_STATUSES = ["active", "inactive", "suspended"] as const;

export const AGGREGATOR_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  suspended: "Suspended",
};

export const AGGREGATOR_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  inactive: "bg-gray-100 text-gray-800",
  suspended: "bg-red-100 text-red-800",
};

// ==========================================
// Virtual Office Purpose Constants
// ==========================================
export const VO_PURPOSES = [
  "gst_registration", "mca_registration", "branch_office",
  "mail_handling", "business_address",
] as const;

export const VO_PURPOSE_LABELS: Record<string, string> = {
  gst_registration: "GST Registration",
  mca_registration: "MCA/Company Registration",
  branch_office: "Branch Office",
  mail_handling: "Mail Handling",
  business_address: "Business Address",
};

export const VO_PURPOSE_COLORS: Record<string, string> = {
  gst_registration: "bg-blue-100 text-blue-800",
  mca_registration: "bg-purple-100 text-purple-800",
  branch_office: "bg-indigo-100 text-indigo-800",
  mail_handling: "bg-cyan-100 text-cyan-800",
  business_address: "bg-teal-100 text-teal-800",
};

// ==========================================
// Entity Type Constants
// ==========================================
export const ENTITY_TYPES = [
  "individual", "proprietorship", "partnership", "llp",
  "pvt_ltd", "public_ltd", "trust", "society", "huf", "other",
] as const;

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  individual: "Individual",
  proprietorship: "Proprietorship",
  partnership: "Partnership Firm",
  llp: "LLP",
  pvt_ltd: "Private Limited",
  public_ltd: "Public Limited",
  trust: "Trust",
  society: "Society",
  huf: "HUF",
  other: "Other",
};

// ==========================================
// KYC Documents Required per Entity Type
// ==========================================
export const KYC_DOCUMENTS: Record<string, string[]> = {
  individual: [
    "Aadhaar Card",
    "PAN Card",
    "Cancelled Cheque",
    "GST Certificate",
  ],
  proprietorship: [
    "PAN Card of Proprietor",
    "Aadhaar Card of Proprietor",
    "GST Registration Certificate",
    "Shop & Establishment Certificate / Udyam Registration",
    "Business Address Proof",
    "Passport-size Photograph of Proprietor",
  ],
  partnership: [
    "Partnership Agreement / Registration Certificate",
    "Authority Letter",
    "Cancelled Cheque",
    "KYC (PAN Card & Aadhaar Card of all Partners)",
    "GST Certificate",
  ],
  llp: [
    "LLP Agreement / Registration Certificate",
    "LLP PAN Card",
    "Cancelled Cheque",
    "KYC (PAN Card & Aadhaar Card of all Partners)",
    "GST Certificate",
  ],
  pvt_ltd: [
    "PAN Card of Company",
    "Certificate of Incorporation",
    "Board Resolution (in favour of authorised signatory executing membership agreement)",
    "MOA & AOA",
    "KYC (PAN Card & Aadhaar Card of all Directors)",
    "Cancelled Cheque",
    "GST Certificate",
  ],
  public_ltd: [
    "PAN Card of Company",
    "Certificate of Incorporation",
    "Board Resolution (in favour of authorised signatory executing membership agreement)",
    "MOA & AOA",
    "KYC (PAN Card & Aadhaar Card of all Directors)",
    "Cancelled Cheque",
    "GST Certificate",
  ],
  trust: [
    "Trust Deed",
    "PAN Card of Trust",
    "PAN & Aadhaar of Trustees",
    "Registration Certificate (if registered)",
    "Authority Letter / Resolution",
    "Address Proof of Trust",
    "Passport-size Photograph of Authorised Trustee",
  ],
  society: [
    "Society Registration Certificate",
    "PAN Card of Society",
    "PAN & Aadhaar of Authorised Members",
    "Resolution / Authority Letter",
    "Address Proof of Society",
    "Passport-size Photograph of Authorised Member",
  ],
  huf: [
    "PAN Card of HUF",
    "PAN & Aadhaar of Karta",
    "HUF Declaration Deed",
    "Address Proof",
    "Passport-size Photograph of Karta",
  ],
  other: [
    "PAN Card",
    "Aadhaar Card / ID Proof",
    "GST Registration Certificate (if applicable)",
    "Address Proof",
    "Passport-size Photograph",
    "Authority Letter (if applicable)",
  ],
};

// ==========================================
// Case Status Constants
// ==========================================
export const CASE_STATUSES = [
  "intake_received", "docs_requested", "docs_received", "under_review",
  "compliance_check", "internal_approved", "sent_for_client_approval",
  "client_approved", "signing_in_progress", "executed",
  "invoiced", "active", "renewal_due", "renewed", "lapsed",
] as const;

export const CASE_STATUS_LABELS: Record<string, string> = {
  intake_received: "Intake Received",
  docs_requested: "Docs Requested",
  docs_received: "Docs Received",
  under_review: "Under Review",
  compliance_check: "Compliance Check",
  internal_approved: "Internally Approved",
  sent_for_client_approval: "Sent for Client Approval",
  client_approved: "Client Approved",
  signing_in_progress: "Signing in Progress",
  executed: "Executed",
  invoiced: "Invoiced",
  active: "Active",
  renewal_due: "Renewal Due",
  renewed: "Renewed",
  lapsed: "Lapsed",
};

export const CASE_STATUS_COLORS: Record<string, string> = {
  intake_received: "bg-gray-100 text-gray-800",
  docs_requested: "bg-yellow-100 text-yellow-800",
  docs_received: "bg-blue-100 text-blue-800",
  under_review: "bg-indigo-100 text-indigo-800",
  compliance_check: "bg-purple-100 text-purple-800",
  internal_approved: "bg-emerald-100 text-emerald-800",
  sent_for_client_approval: "bg-cyan-100 text-cyan-800",
  client_approved: "bg-teal-100 text-teal-800",
  signing_in_progress: "bg-orange-100 text-orange-800",
  executed: "bg-green-100 text-green-800",
  invoiced: "bg-lime-100 text-lime-800",
  active: "bg-green-200 text-green-900",
  renewal_due: "bg-amber-100 text-amber-800",
  renewed: "bg-blue-100 text-blue-800",
  lapsed: "bg-red-100 text-red-800",
};

// Valid status transitions for the case state machine
export const CASE_STATUS_TRANSITIONS: Record<string, string[]> = {
  intake_received: ["docs_requested"],
  docs_requested: ["docs_received"],
  docs_received: ["under_review"],
  under_review: ["compliance_check", "docs_requested"],
  compliance_check: ["internal_approved", "under_review"],
  internal_approved: ["sent_for_client_approval"],
  sent_for_client_approval: ["client_approved", "internal_approved"],
  client_approved: ["signing_in_progress"],
  signing_in_progress: ["executed"],
  executed: ["invoiced"],
  invoiced: ["active"],
  active: ["renewal_due", "lapsed"],
  renewal_due: ["renewed", "lapsed"],
  renewed: ["active"],
  lapsed: [],
};

// Group statuses for Kanban view
export const CASE_STATUS_GROUPS: Record<string, { label: string; statuses: string[] }> = {
  intake: { label: "Intake", statuses: ["intake_received", "docs_requested", "docs_received"] },
  processing: { label: "Processing", statuses: ["under_review", "compliance_check"] },
  approval: { label: "Approval", statuses: ["internal_approved", "sent_for_client_approval", "client_approved"] },
  execution: { label: "Execution", statuses: ["signing_in_progress", "executed", "invoiced"] },
  active: { label: "Active", statuses: ["active", "renewal_due"] },
  closed: { label: "Closed", statuses: ["renewed", "lapsed"] },
};

// ==========================================
// Case Document Status Constants
// ==========================================
export const CASE_DOC_STATUSES = ["pending", "uploaded", "approved", "rejected"] as const;

export const CASE_DOC_STATUS_LABELS: Record<string, string> = {
  pending: "Pending Upload",
  uploaded: "Uploaded",
  approved: "Approved",
  rejected: "Rejected",
};

export const CASE_DOC_STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-800",
  uploaded: "bg-blue-100 text-blue-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

// ==========================================
// Compliance Check Status Constants
// ==========================================
export const COMPLIANCE_STATUSES = ["pending", "passed", "failed", "waived"] as const;

export const COMPLIANCE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  passed: "Passed",
  failed: "Failed",
  waived: "Waived",
};

export const COMPLIANCE_STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-800",
  passed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  waived: "bg-yellow-100 text-yellow-800",
};

// ==========================================
// Agreement Status Constants
// ==========================================
export const AGREEMENT_STATUSES = [
  "draft", "pending_internal_approval", "internally_approved",
  "sent_to_client", "client_approved", "signing", "executed", "expired",
] as const;

export const AGREEMENT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_internal_approval: "Pending Internal Approval",
  internally_approved: "Internally Approved",
  sent_to_client: "Sent to Client",
  client_approved: "Client Approved",
  signing: "Signing in Progress",
  executed: "Executed",
  expired: "Expired",
};

export const AGREEMENT_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  pending_internal_approval: "bg-yellow-100 text-yellow-800",
  internally_approved: "bg-blue-100 text-blue-800",
  sent_to_client: "bg-cyan-100 text-cyan-800",
  client_approved: "bg-teal-100 text-teal-800",
  signing: "bg-orange-100 text-orange-800",
  executed: "bg-green-100 text-green-800",
  expired: "bg-red-100 text-red-800",
};

export const AGREEMENT_TYPE_LABELS: Record<string, string> = {
  proposal: "Proposal",
  leave_license: "Leave & License Agreement",
};

// ==========================================
// Purpose-based Document Checklists
// ==========================================
export const DOCUMENT_CHECKLISTS: Record<string, Record<string, { type: string; label: string; required: boolean }[]>> = {
  gst_registration: {
    individual: [
      { type: "pan_card", label: "PAN Card", required: true },
      { type: "aadhaar_card", label: "Aadhaar Card", required: true },
      { type: "photograph", label: "Passport Size Photo", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
    proprietorship: [
      { type: "pan_card", label: "Proprietor PAN Card", required: true },
      { type: "aadhaar_card", label: "Proprietor Aadhaar Card", required: true },
      { type: "photograph", label: "Passport Size Photo", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
      { type: "trade_license", label: "Trade License / Shop Establishment", required: false },
    ],
    partnership: [
      { type: "partnership_deed", label: "Partnership Deed", required: true },
      { type: "pan_card_firm", label: "Firm PAN Card", required: true },
      { type: "partner_pan", label: "All Partners PAN Cards", required: true },
      { type: "partner_aadhaar", label: "All Partners Aadhaar Cards", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
    llp: [
      { type: "llp_agreement", label: "LLP Agreement", required: true },
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "pan_card_llp", label: "LLP PAN Card", required: true },
      { type: "partner_pan", label: "Designated Partners PAN Cards", required: true },
      { type: "partner_aadhaar", label: "Designated Partners Aadhaar Cards", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
    pvt_ltd: [
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "moa", label: "MOA", required: true },
      { type: "aoa", label: "AOA", required: true },
      { type: "pan_card_company", label: "Company PAN Card", required: true },
      { type: "board_resolution", label: "Board Resolution for Address", required: true },
      { type: "director_pan", label: "All Directors PAN Cards", required: true },
      { type: "director_aadhaar", label: "All Directors Aadhaar Cards", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
    public_ltd: [
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "moa", label: "MOA", required: true },
      { type: "aoa", label: "AOA", required: true },
      { type: "pan_card_company", label: "Company PAN Card", required: true },
      { type: "board_resolution", label: "Board Resolution for Address", required: true },
      { type: "director_pan", label: "All Directors PAN Cards", required: true },
      { type: "director_aadhaar", label: "All Directors Aadhaar Cards", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
    trust: [
      { type: "trust_deed", label: "Trust Deed", required: true },
      { type: "pan_card_trust", label: "Trust PAN Card", required: true },
      { type: "trustee_pan", label: "Trustees PAN Cards", required: true },
      { type: "trustee_aadhaar", label: "Trustees Aadhaar Cards", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
    society: [
      { type: "registration_certificate", label: "Society Registration Certificate", required: true },
      { type: "pan_card_society", label: "Society PAN Card", required: true },
      { type: "member_pan", label: "Office Bearers PAN Cards", required: true },
      { type: "member_aadhaar", label: "Office Bearers Aadhaar Cards", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
    huf: [
      { type: "huf_deed", label: "HUF Deed", required: true },
      { type: "pan_card_huf", label: "HUF PAN Card", required: true },
      { type: "karta_pan", label: "Karta PAN Card", required: true },
      { type: "karta_aadhaar", label: "Karta Aadhaar Card", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
    other: [
      { type: "pan_card", label: "PAN Card", required: true },
      { type: "aadhaar_card", label: "Aadhaar Card", required: true },
      { type: "cancelled_cheque", label: "Cancelled Cheque / Bank Statement", required: true },
    ],
  },
  mca_registration: {
    pvt_ltd: [
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "moa", label: "MOA", required: true },
      { type: "aoa", label: "AOA", required: true },
      { type: "pan_card_company", label: "Company PAN Card", required: true },
      { type: "board_resolution", label: "Board Resolution for Registered Office", required: true },
      { type: "director_pan", label: "All Directors PAN Cards", required: true },
      { type: "director_aadhaar", label: "All Directors Aadhaar Cards", required: true },
      { type: "director_din", label: "Director DIN Details", required: true },
    ],
    llp: [
      { type: "llp_agreement", label: "LLP Agreement", required: true },
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "pan_card_llp", label: "LLP PAN Card", required: true },
      { type: "partner_pan", label: "Designated Partners PAN Cards", required: true },
      { type: "partner_aadhaar", label: "Designated Partners Aadhaar Cards", required: true },
      { type: "partner_dpin", label: "Partners DPIN Details", required: true },
    ],
    public_ltd: [
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "moa", label: "MOA", required: true },
      { type: "aoa", label: "AOA", required: true },
      { type: "pan_card_company", label: "Company PAN Card", required: true },
      { type: "board_resolution", label: "Board Resolution for Registered Office", required: true },
      { type: "director_pan", label: "All Directors PAN Cards", required: true },
      { type: "director_aadhaar", label: "All Directors Aadhaar Cards", required: true },
      { type: "director_din", label: "Director DIN Details", required: true },
    ],
  },
  branch_office: {
    pvt_ltd: [
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "pan_card_company", label: "Company PAN Card", required: true },
      { type: "board_resolution", label: "Board Resolution for Branch Office", required: true },
      { type: "gst_certificate", label: "Main Office GST Certificate", required: true },
      { type: "authorized_signatory_id", label: "Authorized Signatory ID Proof", required: true },
    ],
    llp: [
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "pan_card_llp", label: "LLP PAN Card", required: true },
      { type: "partner_authorization", label: "Partner Authorization Letter", required: true },
      { type: "gst_certificate", label: "Main Office GST Certificate", required: true },
      { type: "authorized_signatory_id", label: "Authorized Signatory ID Proof", required: true },
    ],
  },
  mail_handling: {
    individual: [
      { type: "pan_card", label: "PAN Card", required: true },
      { type: "aadhaar_card", label: "Aadhaar Card", required: true },
    ],
    proprietorship: [
      { type: "pan_card", label: "Proprietor PAN Card", required: true },
      { type: "aadhaar_card", label: "Proprietor Aadhaar Card", required: true },
    ],
    pvt_ltd: [
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "pan_card_company", label: "Company PAN Card", required: true },
      { type: "authorized_signatory_id", label: "Authorized Signatory ID Proof", required: true },
    ],
  },
  business_address: {
    individual: [
      { type: "pan_card", label: "PAN Card", required: true },
      { type: "aadhaar_card", label: "Aadhaar Card", required: true },
      { type: "photograph", label: "Passport Size Photo", required: true },
    ],
    proprietorship: [
      { type: "pan_card", label: "Proprietor PAN Card", required: true },
      { type: "aadhaar_card", label: "Proprietor Aadhaar Card", required: true },
    ],
    pvt_ltd: [
      { type: "coi", label: "Certificate of Incorporation", required: true },
      { type: "pan_card_company", label: "Company PAN Card", required: true },
      { type: "board_resolution", label: "Board Resolution", required: true },
      { type: "authorized_signatory_id", label: "Authorized Signatory ID Proof", required: true },
    ],
  },
};

// ==========================================
// Purpose-based Compliance Checklists
// ==========================================
export const COMPLIANCE_CHECKLISTS: Record<string, { check_name: string; check_category: string; sort_order: number }[]> = {
  gst_registration: [
    { check_name: "PAN number format verified", check_category: "identity", sort_order: 1 },
    { check_name: "Aadhaar linked to mobile (OTP capable)", check_category: "identity", sort_order: 2 },
    { check_name: "Entity name matches PAN records", check_category: "identity", sort_order: 3 },
    { check_name: "Address proof matches state of registration", check_category: "address", sort_order: 4 },
    { check_name: "No blacklist match on entity or directors", check_category: "legal", sort_order: 5 },
    { check_name: "Address unit available at requested location", check_category: "address", sort_order: 6 },
    { check_name: "All required documents approved", check_category: "documents", sort_order: 7 },
  ],
  mca_registration: [
    { check_name: "CIN format verified (if existing company)", check_category: "identity", sort_order: 1 },
    { check_name: "Director DIN status is active", check_category: "identity", sort_order: 2 },
    { check_name: "Entity name matches MCA records", check_category: "identity", sort_order: 3 },
    { check_name: "MOA/AOA consistent with registration purpose", check_category: "legal", sort_order: 4 },
    { check_name: "Board resolution authorizes address change", check_category: "legal", sort_order: 5 },
    { check_name: "No blacklist match on entity or directors", check_category: "legal", sort_order: 6 },
    { check_name: "Address unit available at requested location", check_category: "address", sort_order: 7 },
    { check_name: "All required documents approved", check_category: "documents", sort_order: 8 },
  ],
  branch_office: [
    { check_name: "Main office GST certificate verified", check_category: "tax", sort_order: 1 },
    { check_name: "Board resolution authorizes branch setup", check_category: "legal", sort_order: 2 },
    { check_name: "Authorized signatory identity verified", check_category: "identity", sort_order: 3 },
    { check_name: "No blacklist match on entity", check_category: "legal", sort_order: 4 },
    { check_name: "Address unit available at requested location", check_category: "address", sort_order: 5 },
    { check_name: "All required documents approved", check_category: "documents", sort_order: 6 },
  ],
  mail_handling: [
    { check_name: "Identity documents verified", check_category: "identity", sort_order: 1 },
    { check_name: "Address unit available at requested location", check_category: "address", sort_order: 2 },
    { check_name: "All required documents approved", check_category: "documents", sort_order: 3 },
  ],
  business_address: [
    { check_name: "Identity documents verified", check_category: "identity", sort_order: 1 },
    { check_name: "Entity type and purpose consistent", check_category: "legal", sort_order: 2 },
    { check_name: "Address unit available at requested location", check_category: "address", sort_order: 3 },
    { check_name: "All required documents approved", check_category: "documents", sort_order: 4 },
  ],
};

// ==========================================
// Aggregator Invoice Constants
// ==========================================
export const AGG_INVOICE_STATUSES = ["draft", "sent", "paid", "overdue", "cancelled"] as const;

export const AGG_INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

export const AGG_INVOICE_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  sent: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  overdue: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-600",
};

// ==========================================
// Support Ticket Constants
// ==========================================
export const TICKET_TYPES = ["bug", "feature_request", "feedback", "question"] as const;

export const TICKET_TYPE_LABELS: Record<string, string> = {
  bug: "Bug Report",
  feature_request: "Feature Request",
  feedback: "Feedback",
  question: "Question",
};

export const TICKET_TYPE_COLORS: Record<string, string> = {
  bug: "bg-red-100 text-red-800",
  feature_request: "bg-purple-100 text-purple-800",
  feedback: "bg-blue-100 text-blue-800",
  question: "bg-cyan-100 text-cyan-800",
};

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed", "build_approved"] as const;

export const TICKET_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
  build_approved: "Build Approved",
};

export const TICKET_STATUS_COLORS: Record<string, string> = {
  open: "bg-yellow-100 text-yellow-800",
  in_progress: "bg-blue-100 text-blue-800",
  resolved: "bg-green-100 text-green-800",
  closed: "bg-gray-100 text-gray-800",
  build_approved: "bg-emerald-100 text-emerald-800",
};

// ==========================================
// Procurement Module
// ==========================================

export const PROCUREMENT_APPROVAL_THRESHOLDS = {
  ADMIN_REQUIRED_ABOVE: 25000, // INR — PRs above this amount require admin approval
};

export const PROCUREMENT_DEPARTMENTS = ["pantry", "maintenance", "administration", "asset"] as const;
export type ProcurementDepartment = (typeof PROCUREMENT_DEPARTMENTS)[number];

export const PROCUREMENT_DEPARTMENT_LABELS: Record<string, string> = {
  pantry: "Pantry",
  maintenance: "Maintenance",
  administration: "Administration",
  asset: "Asset",
};

export const PROCUREMENT_DEPARTMENT_COLORS: Record<string, string> = {
  pantry: "bg-orange-100 text-orange-800",
  maintenance: "bg-blue-100 text-blue-800",
  administration: "bg-purple-100 text-purple-800",
  asset: "bg-emerald-100 text-emerald-800",
};

export const VENDOR_CATEGORIES = ["pantry", "maintenance", "administration", "general"] as const;
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

export const VENDOR_CATEGORY_LABELS: Record<string, string> = {
  pantry: "Pantry",
  maintenance: "Maintenance",
  administration: "Administration",
  general: "General",
};

export const ITEM_UNITS = ["kg", "litre", "packet", "box", "piece", "roll", "dozen", "bottle", "bag", "set", "pair", "month", "quarter", "year", "nos", "can", "ton"] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

export const GST_RATES = [0, 5, 12, 18, 28] as const;
export const GST_RATE_LABELS: Record<number, string> = {
  0: "0% (Exempt)",
  5: "5%",
  12: "12%",
  18: "18%",
  28: "28%",
};

export const PR_STATUSES = [
  "draft", "submitted", "approved", "rejected",
  "partially_ordered", "po_created", "cancelled",
] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

export const PR_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  partially_ordered: "Partially Ordered",
  po_created: "PO Created",
  cancelled: "Cancelled",
};

export const PR_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  submitted: "bg-yellow-100 text-yellow-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  partially_ordered: "bg-amber-100 text-amber-800",
  po_created: "bg-blue-100 text-blue-800",
  cancelled: "bg-gray-100 text-gray-500",
};

export const PO_STATUSES = [
  "pending", "ordered", "partially_received", "received",
  "invoice_received", "invoice_approved", "cancelled", "partially_cancelled",
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  ordered: "Ordered",
  partially_received: "Partially Received",
  received: "Received",
  invoice_received: "Invoice Received",
  invoice_approved: "Invoice Approved",
  cancelled: "Cancelled",
  partially_cancelled: "Partially Cancelled",
};

export const PO_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  ordered: "bg-blue-100 text-blue-800",
  partially_received: "bg-orange-100 text-orange-800",
  received: "bg-green-100 text-green-800",
  invoice_received: "bg-purple-100 text-purple-800",
  invoice_approved: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-gray-100 text-gray-500",
  partially_cancelled: "bg-orange-100 text-orange-700",
};

export const BILL_PAYMENT_STATUSES = ["unpaid", "partially_paid", "paid"] as const;
export type BillPaymentStatus = (typeof BILL_PAYMENT_STATUSES)[number];

export const BILL_PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partially Paid",
  paid: "Paid",
};

export const BILL_PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid: "bg-red-100 text-red-800",
  partially_paid: "bg-yellow-100 text-yellow-800",
  paid: "bg-green-100 text-green-800",
};

export const BILL_PAYMENT_MODES = ["cash", "upi", "bank_transfer"] as const;
export type BillPaymentMode = (typeof BILL_PAYMENT_MODES)[number];

export const BILL_PAYMENT_MODE_LABELS: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  bank_transfer: "Bank Transfer",
};

// Bill Approval
export const BILL_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type BillApprovalStatus = (typeof BILL_APPROVAL_STATUSES)[number];

export const BILL_APPROVAL_STATUS_LABELS: Record<string, string> = {
  pending: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
};

export const BILL_APPROVAL_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export const REJECTION_OUTCOME_LABELS: Record<string, string> = {
  return: "Return Goods & Cancel PO",
  replacement: "Request Replacement (New PR)",
  void: "Void (Service Invoice)",
};

// Payment Batch Scheduling
export const PAYMENT_BATCH_TYPES = ["immediate", "15th", "25th"] as const;

export const PAYMENT_BATCH_TYPE_LABELS: Record<string, string> = {
  immediate: "Immediate",
  "15th": "15th of Month",
  "25th": "25th of Month",
};

export const PAYMENT_BATCH_TYPE_COLORS: Record<string, string> = {
  immediate: "bg-blue-100 text-blue-800",
  "15th": "bg-violet-100 text-violet-800",
  "25th": "bg-indigo-100 text-indigo-800",
};

export const ITEM_TYPES = ["goods", "service"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<string, string> = {
  goods: "Goods",
  service: "Service",
};

// Service PO billing cycles (subset of contract BILLING_CYCLES — excludes half_yearly)
export const SERVICE_PO_BILLING_CYCLES = ["monthly", "quarterly", "yearly"] as const;
export type ServicePoBillingCycle = (typeof SERVICE_PO_BILLING_CYCLES)[number];

// PO Advance Payment
export const PO_ADVANCE_STATUSES = ["not_required", "pending", "processed"] as const;
export type PoAdvanceStatus = (typeof PO_ADVANCE_STATUSES)[number];

export const PO_ADVANCE_STATUS_LABELS: Record<string, string> = {
  not_required: "No Advance",
  pending: "Advance Pending",
  processed: "Advance Processed",
};

export const PO_ADVANCE_STATUS_COLORS: Record<string, string> = {
  not_required: "bg-gray-100 text-gray-600",
  pending: "bg-orange-100 text-orange-800",
  processed: "bg-green-100 text-green-800",
};

export const PO_ADVANCE_PAYMENT_MODES = ["cash", "upi", "bank_transfer"] as const;
export type PoAdvancePaymentMode = (typeof PO_ADVANCE_PAYMENT_MODES)[number];

export const PO_ADVANCE_PAYMENT_MODE_LABELS: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  bank_transfer: "Bank Transfer",
};

// ─────────────────────────────────────────────────────────────────────────────
// Prepaid Package Constants
// ─────────────────────────────────────────────────────────────────────────────
export const CREDIT_TYPES = ["hours", "days", "bookings"] as const;

export const CREDIT_TYPE_LABELS: Record<string, string> = {
  hours: "Hours",
  days: "Days",
  bookings: "Booking Slots",
};

export const PREPAID_PURCHASE_STATUSES = ["active", "exhausted", "expired"] as const;

export const PREPAID_PURCHASE_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  exhausted: "Exhausted",
  expired: "Expired",
};

export const PREPAID_PURCHASE_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  exhausted: "bg-gray-100 text-gray-600",
  expired: "bg-red-100 text-red-800",
};

// ==========================================
// Petty Cash Constants
// ==========================================

export const PC_REQUEST_STATUSES = ["pending", "approved", "issued", "rejected"] as const;

export const PC_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Awaiting Issuance",
  issued: "Issued",
  rejected: "Rejected",
};

export const PC_REQUEST_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-orange-100 text-orange-800",
  issued: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export const PC_ENTRY_STATUSES = ["pending_manager", "pending_admin", "approved", "rejected"] as const;

export const PC_ENTRY_STATUS_LABELS: Record<string, string> = {
  pending_manager: "Pending Manager",
  pending_admin: "Pending Admin",
  approved: "Approved",
  rejected: "Rejected",
};

export const PC_ENTRY_STATUS_COLORS: Record<string, string> = {
  pending_manager: "bg-yellow-100 text-yellow-800",
  pending_admin: "bg-orange-100 text-orange-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export const PC_ISSUANCE_METHODS = ["cash", "upi", "bank_transfer", "cheque"] as const;

export const PC_ISSUANCE_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  bank_transfer: "Bank Transfer",
  cheque: "Cheque",
};

// ─── Inventory & Stock Transfer Constants ────────────────────────────────────

export const TRANSFER_STATUSES = ["draft", "pending_approval", "approved", "dispatched", "received", "completed", "issue_raised"] as const;

export const TRANSFER_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Pending Approval",
  approved: "Approved",
  dispatched: "Dispatched",
  received: "Received",
  completed: "Completed",
  issue_raised: "Issue Raised",
};

export const TRANSFER_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  pending_approval: "bg-yellow-100 text-yellow-800",
  approved: "bg-blue-100 text-blue-800",
  dispatched: "bg-purple-100 text-purple-800",
  received: "bg-green-100 text-green-800",
  completed: "bg-emerald-100 text-emerald-800",
  issue_raised: "bg-red-100 text-red-800",
};

export const TRANSFER_ISSUE_TYPES = ["shortage", "excess", "damage", "wrong_item", "quality", "other"] as const;

export const TRANSFER_ISSUE_TYPE_LABELS: Record<string, string> = {
  shortage: "Shortage",
  excess: "Excess Received",
  damage: "Damaged Goods",
  wrong_item: "Wrong Item",
  quality: "Quality Issue",
  other: "Other",
};

export const TRANSFER_ISSUE_STATUSES = ["open", "investigating", "resolved"] as const;

export const TRANSFER_ISSUE_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  investigating: "Investigating",
  resolved: "Resolved",
};

export const TRANSFER_ISSUE_STATUS_COLORS: Record<string, string> = {
  open: "bg-red-100 text-red-800",
  investigating: "bg-amber-100 text-amber-800",
  resolved: "bg-green-100 text-green-800",
};

export const CONSUMPTION_STATUSES = ["active", "voided"] as const;

export const CONSUMPTION_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  voided: "Voided",
};

export const CONSUMPTION_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  voided: "bg-red-100 text-red-800",
};

export const CORRECTION_TYPES = ["void", "adjust", "relog"] as const;

export const CORRECTION_TYPE_LABELS: Record<string, string> = {
  void: "Void Entry",
  adjust: "Adjust Quantity",
  relog: "Re-log (Void & Replace)",
};

// ── Expenditure Types ─────────────────────────────────────────────────────────
export const EXPENDITURE_TYPES = ["operational", "amc"] as const;
export type ExpenditureType = (typeof EXPENDITURE_TYPES)[number];

export const EXPENDITURE_TYPE_LABELS: Record<string, string> = {
  operational: "Operational",
  amc: "AMC / Annual Contract",
};

export const EXPENDITURE_TYPE_DESCRIPTIONS: Record<string, string> = {
  operational: "Counts against monthly department budget",
  amc: "Annual maintenance contract — excluded from monthly budget",
};

export const EXPENDITURE_TYPE_COLORS: Record<string, string> = {
  operational: "bg-blue-100 text-blue-800",
  amc: "bg-purple-100 text-purple-800",
};

// ── Rent Management ───────────────────────────────────────────────────────────

export const RENT_MANAGEMENT_ROLES = ["admin", "accounts", "viewer"] as const;

export const LEASE_STATUSES = ["active", "expired", "terminated", "on_hold"] as const;

export const LEASE_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  expired: "Expired",
  terminated: "Terminated",
  on_hold: "On Hold",
};

export const LEASE_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  expired: "bg-gray-100 text-gray-800",
  terminated: "bg-red-100 text-red-800",
  on_hold: "bg-yellow-100 text-yellow-800",
};

export const LEASE_PAYMENT_STATUSES = ["pending", "paid", "overdue", "on_hold", "disputed"] as const;

export const LEASE_PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  overdue: "Overdue",
  on_hold: "On Hold",
  disputed: "Disputed",
};

export const LEASE_PAYMENT_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  paid: "bg-green-100 text-green-800",
  overdue: "bg-red-100 text-red-800",
  on_hold: "bg-orange-100 text-orange-800",
  disputed: "bg-purple-100 text-purple-800",
};

export const ESCALATION_TYPES = ["none", "percentage", "flat", "step_up"] as const;

export const ESCALATION_TYPE_LABELS: Record<string, string> = {
  none: "No Escalation",
  percentage: "Percentage (%)",
  flat: "Flat Amount (₹)",
  step_up: "Step-Up (₹/period)",
};

export const ESCALATION_STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  applied: "Applied",
  disputed: "Disputed",
  waived: "Waived",
};

export const ESCALATION_STATUS_COLORS: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-800",
  applied: "bg-green-100 text-green-800",
  disputed: "bg-red-100 text-red-800",
  waived: "bg-gray-100 text-gray-800",
};

export const ASSET_CATEGORIES = ["civil", "electrical", "furniture", "equipment", "it", "fitting", "other"] as const;

export const ASSET_CATEGORY_LABELS: Record<string, string> = {
  civil: "Civil / Structural",
  electrical: "Electrical",
  furniture: "Furniture",
  equipment: "Equipment",
  it: "IT / Technology",
  fitting: "Fixtures & Fittings",
  other: "Other",
};

export const ASSET_CONDITION_LABELS: Record<string, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

export const HANDOVER_TYPE_LABELS: Record<string, string> = {
  takeover: "Takeover",
  return: "Return",
  mid_term_addition: "Mid-Term Addition",
};

export const HANDOVER_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  completed: "bg-green-100 text-green-800",
  disputed: "bg-red-100 text-red-800",
};

export const LEASE_DOCUMENT_TYPES = ["lease_deed", "floor_plan", "electrical_drawing", "noc", "amendment", "correspondence", "other"] as const;

export const LEASE_DOCUMENT_TYPE_LABELS: Record<string, string> = {
  lease_deed: "Lease Deed",
  floor_plan: "Floor Plan",
  electrical_drawing: "Electrical Drawing",
  noc: "NOC",
  amendment: "Amendment",
  correspondence: "Correspondence",
  other: "Other",
};

export const LEASE_SERVICE_NAMES = ["electricity", "water", "cam", "security", "parking", "wifi", "generator", "hvac", "housekeeping", "other"] as const;

export const LEASE_SERVICE_NAME_LABELS: Record<string, string> = {
  electricity: "Electricity",
  water: "Water",
  cam: "Common Area Maintenance (CAM)",
  security: "Security",
  parking: "Parking",
  wifi: "WiFi / Internet",
  generator: "Generator / DG Set",
  hvac: "HVAC / Air Conditioning",
  housekeeping: "Housekeeping",
  other: "Other",
};

export const LANDLORD_KYC_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  verified: "Verified",
  incomplete: "Incomplete",
};

export const LANDLORD_KYC_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  verified: "bg-green-100 text-green-800",
  incomplete: "bg-red-100 text-red-800",
};

export const LEASE_PAYMENT_MODE_LABELS: Record<string, string> = {
  bank_transfer: "Bank Transfer",
  cheque: "Cheque",
  neft: "NEFT",
  rtgs: "RTGS",
  upi: "UPI",
};

export const TDS_SECTIONS = ["194I", "194IB"] as const;

export const TDS_SECTION_LABELS: Record<string, string> = {
  "194I": "194I — Commercial Property (≥₹2.4L/yr)",
  "194IB": "194IB — Residential / Small Landlord",
};

export const TDS_DEFAULT_RATES: Record<string, number> = {
  "194I": 10,
  "194IB": 5,
};

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

export const INVOICE_STATUSES = ["draft", "sent", "paid", "overdue", "cancelled"] as const;

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

export const USER_ROLES = ["admin", "manager", "sales_rep"] as const;

export const USER_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  sales_rep: "Sales Rep",
};

export const RATINGS = ["none", "hot", "warm", "cold"] as const;

export const RATING_LABELS: Record<string, string> = {
  none: "None",
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
};

// ==========================================
// Contract Constants
// ==========================================
export const CONTRACT_STATUSES = [
  "draft",
  "active",
  "renewed",
  "expired",
  "terminated",
] as const;

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  renewed: "Renewed",
  expired: "Expired",
  terminated: "Terminated",
};

export const CONTRACT_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  active: "bg-green-100 text-green-800",
  renewed: "bg-blue-100 text-blue-800",
  expired: "bg-orange-100 text-orange-800",
  terminated: "bg-red-100 text-red-800",
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

export const VOUCHER_VALIDITY_OPTIONS = [1, 7, 30, 60, 90, 365] as const;

export const VOUCHER_VALIDITY_LABELS: Record<number, string> = {
  1: "1 Day",
  7: "7 Days",
  30: "30 Days",
  60: "60 Days",
  90: "90 Days",
  365: "365 Days",
};

export const VOUCHER_LOW_STOCK_THRESHOLD = 10;

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

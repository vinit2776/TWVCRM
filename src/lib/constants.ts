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

export const USER_ROLES = ["admin", "manager", "sales_rep", "floor_manager"] as const;

export const USER_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  sales_rep: "Sales Rep",
  floor_manager: "Floor Manager",
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
  "sent",
  "viewed",
  "accepted",
  "rejected",
  "active",
  "renewed",
  "expired",
  "terminated",
] as const;

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  rejected: "Rejected",
  active: "Active",
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

export const VOUCHER_VALIDITY_OPTIONS = [1, 7, 30, 60, 90, 180, 365] as const;

export const VOUCHER_VALIDITY_LABELS: Record<number, string> = {
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
] as const;

export const BOOKING_PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  waived: "Waived",
  posted_to_bill: "Posted to Bill",
};

export const BOOKING_PAYMENT_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  paid: "bg-green-100 text-green-800",
  waived: "bg-gray-100 text-gray-800",
  posted_to_bill: "bg-blue-100 text-blue-800",
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

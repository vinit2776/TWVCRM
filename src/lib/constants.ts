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

export const DOCUMENT_CATEGORIES = [
  "contract",
  "identity",
  "proposal",
  "invoice",
  "general",
] as const;

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

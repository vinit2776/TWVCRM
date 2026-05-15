import type { UserRole } from "@/types";

// ─── Widget identifiers ────────────────────────────────────────────────────

export type WidgetId =
  // Existing
  | "pending_actions"
  | "live_enquiries"
  | "kpi_stats"
  | "followups"
  | "recent_activities"
  | "recent_leads"
  | "notes"
  | "procurement_summary"
  | "support_summary"
  | "team_performance"
  | "booking_summary"
  | "financial_summary"
  // New (Tier 1: money & churn)
  | "renewal_pipeline"
  | "cash_aging"
  | "revenue_pulse"
  | "occupancy"
  // New (Tier 2: operational signal)
  | "sla_risk"
  | "member_health"
  | "lead_funnel"
  | "schedule"
  // New (Tier 3: strategic)
  | "source_roi"
  | "aggregator_performance"
  | "procurement_spend"
  | "quota_overuse"
  | "mtd_bookings";

// ─── Widget metadata registry ──────────────────────────────────────────────

export interface WidgetMeta {
  id: WidgetId;
  title: string;
}

export const WIDGET_REGISTRY: Record<WidgetId, WidgetMeta> = {
  pending_actions:        { id: "pending_actions",        title: "Pending Actions" },
  live_enquiries:         { id: "live_enquiries",         title: "Live Enquiries" },
  kpi_stats:              { id: "kpi_stats",              title: "Key Metrics" },
  followups:              { id: "followups",              title: "Follow-ups" },
  recent_activities:      { id: "recent_activities",      title: "Recent Activities" },
  recent_leads:           { id: "recent_leads",           title: "Recent Leads" },
  notes:                  { id: "notes",                  title: "Unread Notes" },
  procurement_summary:    { id: "procurement_summary",    title: "Procurement Overview" },
  support_summary:        { id: "support_summary",        title: "Support Tickets" },
  team_performance:       { id: "team_performance",       title: "Team Activity This Week" },
  booking_summary:        { id: "booking_summary",        title: "Today's Bookings" },
  financial_summary:      { id: "financial_summary",      title: "Financial Overview" },
  renewal_pipeline:       { id: "renewal_pipeline",       title: "Renewal Pipeline" },
  cash_aging:             { id: "cash_aging",             title: "Cash Aging" },
  revenue_pulse:          { id: "revenue_pulse",          title: "Revenue Pulse" },
  occupancy:              { id: "occupancy",              title: "Occupancy" },
  sla_risk:               { id: "sla_risk",               title: "SLA Risk Board" },
  member_health:          { id: "member_health",          title: "Member Health" },
  lead_funnel:            { id: "lead_funnel",            title: "Lead Funnel" },
  schedule:               { id: "schedule",               title: "Today's Schedule" },
  source_roi:             { id: "source_roi",             title: "Source ROI" },
  aggregator_performance: { id: "aggregator_performance", title: "Aggregator Performance" },
  procurement_spend:      { id: "procurement_spend",      title: "Procurement Spend" },
  quota_overuse:          { id: "quota_overuse",          title: "Quota Overuse" },
  mtd_bookings:           { id: "mtd_bookings",           title: "Bookings Value (MTD)" },
};

// ─── Role → widget order ───────────────────────────────────────────────────
//
// Single source of truth for dashboard layout per role. To add a widget,
// insert its WidgetId into the role's array.

export const DASHBOARD_ROLE_WIDGETS: Record<UserRole, WidgetId[]> = {
  admin: [
    "pending_actions",
    "live_enquiries",
    "kpi_stats",
    "mtd_bookings",
    "revenue_pulse",
    "renewal_pipeline",
    "cash_aging",
    "occupancy",
    "sla_risk",
    "lead_funnel",
    "source_roi",
    "schedule",
    "member_health",
    "aggregator_performance",
    "quota_overuse",
    "procurement_spend",
    "team_performance",
    "followups",
  ],

  manager: [
    "pending_actions",
    "live_enquiries",
    "kpi_stats",
    "mtd_bookings",
    "schedule",
    "renewal_pipeline",
    "occupancy",
    "lead_funnel",
    "revenue_pulse",
    "sla_risk",
    "source_roi",
    "member_health",
    "team_performance",
    "followups",
  ],

  sales_rep: [
    "live_enquiries",
    "schedule",
    "lead_funnel",
    "kpi_stats",
    "followups",
    "recent_leads",
  ],

  floor_manager: [
    "live_enquiries",
    "schedule",
    "booking_summary",
    "mtd_bookings",
    "kpi_stats",
    "followups",
  ],

  // Accounts: finance/accounts team
  accounts: [
    "mtd_bookings",
    "cash_aging",
    "revenue_pulse",
    "renewal_pipeline",
    "quota_overuse",
    "aggregator_performance",
    "procurement_spend",
    "financial_summary",
  ],

  // FMS: Facility Manager
  fms: [
    "sla_risk",
    "procurement_spend",
    "procurement_summary",
  ],

  // Office Administrator
  office_admin: [
    "schedule",
    "mtd_bookings",
    "procurement_spend",
    "sla_risk",
    "procurement_summary",
    "booking_summary",
  ],

  // IT Manager
  it_manager: [
    "sla_risk",
  ],

  // IT Technician
  it_technician: [
    "sla_risk",
  ],
};

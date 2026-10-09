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
  | "sales"
  | "procurement_po"
  | "facility"
  | "meter_telemetry"
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
  | "pending_overtime_charges"
  | "mtd_bookings"
  | "rent_revenue"
  | "network"
  | "week_in_review"
  | "quick_charge"
  | "accounts_overview";

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
  sales:                  { id: "sales",                  title: "Sales" },
  procurement_po:         { id: "procurement_po",         title: "Procurement POs" },
  facility:               { id: "facility",               title: "Facilities" },
  meter_telemetry:        { id: "meter_telemetry",        title: "Live Meter Telemetry" },
  occupancy:              { id: "occupancy",              title: "Occupancy" },
  sla_risk:               { id: "sla_risk",               title: "SLA Risk Board" },
  member_health:          { id: "member_health",          title: "Member Health" },
  lead_funnel:            { id: "lead_funnel",            title: "Lead Funnel" },
  schedule:               { id: "schedule",               title: "Today's Schedule" },
  source_roi:             { id: "source_roi",             title: "Source ROI" },
  aggregator_performance: { id: "aggregator_performance", title: "Aggregator Performance" },
  procurement_spend:      { id: "procurement_spend",      title: "Procurement Spend" },
  quota_overuse:          { id: "quota_overuse",          title: "Quota Overuse" },
  pending_overtime_charges: { id: "pending_overtime_charges", title: "Pending Usage Charges" },
  mtd_bookings:           { id: "mtd_bookings",           title: "Bookings Value (MTD)" },
  rent_revenue:           { id: "rent_revenue",           title: "Rent vs Revenue" },
  network:                { id: "network",                title: "Network Status" },
  week_in_review:         { id: "week_in_review",         title: "Last 7 Days" },
  quick_charge:           { id: "quick_charge",           title: "Log a Charge" },
  accounts_overview:      { id: "accounts_overview",      title: "Accounts Overview" },
};

// ─── Role → widget order ───────────────────────────────────────────────────
//
// Single source of truth for dashboard layout per role. To add a widget,
// insert its WidgetId into the role's array.

export const DASHBOARD_ROLE_WIDGETS: Record<UserRole, WidgetId[]> = {
  // Admin sees only these four management widgets. Every other role keeps its own set.
  admin: [
    "sales",
    "procurement_po",
    "facility",
    "meter_telemetry",
  ],

  manager: [
    "pending_actions",
    "live_enquiries",
    "quick_charge",
    "kpi_stats",
    "mtd_bookings",
    "schedule",
    "renewal_pipeline",
    "occupancy",
    "lead_funnel",
    "revenue_pulse",
    "sla_risk",
    "pending_overtime_charges",
    "source_roi",
    "member_health",
    "team_performance",
    "followups",
  ],

  sales_rep: [
    "live_enquiries",
    "quick_charge",
    "schedule",
    "lead_funnel",
    "kpi_stats",
    "followups",
    "recent_leads",
  ],

  floor_manager: [
    "quick_charge",
    "live_enquiries",
    "schedule",
    "booking_summary",
    "mtd_bookings",
    "kpi_stats",
    "followups",
  ],

  // Accounts: finance/accounts team.
  //
  // Deliberately a single widget. The previous nine were inherited from the
  // admin/sales set — MTD totals, ROI, renewal pipeline — none of which is
  // accounts work. AccountsOverviewWidget answers the two questions this role
  // actually opens the dashboard for: what is queued on me, and where does the
  // money stand.
  accounts: [
    "accounts_overview",
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
    "network",
    "sla_risk",
  ],

  // IT Technician
  it_technician: [
    "network",
    "sla_risk",
  ],

  // Management Viewer — read-only observer; sees high-level KPIs across all areas
  viewer: [
    "kpi_stats",
    "mtd_bookings",
    "revenue_pulse",
    "occupancy",
    "renewal_pipeline",
    "cash_aging",
    "sla_risk",
    "procurement_spend",
  ],
};

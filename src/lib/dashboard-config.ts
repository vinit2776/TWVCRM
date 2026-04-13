import type { UserRole } from "@/types";

// ─── Widget identifiers ────────────────────────────────────────────────────

export type WidgetId =
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
  | "financial_summary";

// ─── Widget metadata registry ──────────────────────────────────────────────

export interface WidgetMeta {
  id: WidgetId;
  title: string;
}

export const WIDGET_REGISTRY: Record<WidgetId, WidgetMeta> = {
  live_enquiries:      { id: "live_enquiries",      title: "Live Enquiries" },
  kpi_stats:           { id: "kpi_stats",           title: "Key Metrics" },
  followups:           { id: "followups",           title: "Follow-ups" },
  recent_activities:   { id: "recent_activities",   title: "Recent Activities" },
  recent_leads:        { id: "recent_leads",        title: "Recent Leads" },
  notes:               { id: "notes",               title: "Unread Notes" },
  procurement_summary: { id: "procurement_summary", title: "Procurement Overview" },
  support_summary:     { id: "support_summary",     title: "Support Tickets" },
  team_performance:    { id: "team_performance",    title: "Team Activity This Week" },
  booking_summary:     { id: "booking_summary",     title: "Today's Bookings" },
  financial_summary:   { id: "financial_summary",   title: "Financial Overview" },
};

// ─── Role → widget order ───────────────────────────────────────────────────
//
// This is the single source of truth for dashboard layout per role.
// To add a widget to a role: insert its WidgetId into the array below.
// To remove a widget: delete its entry. No component changes needed.
//
// Future: move this config into app_settings table for live admin-UI editing.

export const DASHBOARD_ROLE_WIDGETS: Record<UserRole, WidgetId[]> = {
  admin: [
    "live_enquiries",
    "kpi_stats",
    "procurement_summary",
    "support_summary",
    "followups",
    "recent_leads",
    "recent_activities",
    "notes",
    "team_performance",
    "booking_summary",
  ],

  manager: [
    "live_enquiries",
    "kpi_stats",
    "procurement_summary",
    "booking_summary",
    "followups",
    "recent_leads",
    "recent_activities",
    "notes",
    "team_performance",
  ],

  sales_rep: [
    "live_enquiries",
    "kpi_stats",
    "followups",
    "recent_leads",
    "recent_activities",
    "notes",
  ],

  floor_manager: [
    "live_enquiries",
    "booking_summary",
    "kpi_stats",
    "followups",
    "recent_leads",
    "recent_activities",
    "notes",
  ],

  // Accounts: finance/accounts team — focused on financial operations only
  accounts: [
    "financial_summary",
  ],

  // FMS: Facility Manager — full procurement operational view
  fms: [
    "procurement_summary",
  ],

  // Office Administrator — procurement + operations focus
  office_admin: [
    "procurement_summary",
    "booking_summary",
  ],
};

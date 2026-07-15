/**
 * Facility — client-side UI helpers shared across pages and components.
 * Pure functions only. No React, no Supabase.
 */

import type {
  FacilityIssuePriority,
  FacilityIssueStatus,
  FacilityRootCause,
  FacilityScope,
  FacilityReportedVia,
  FacilityTatReason,
} from "@/types";

/** Tailwind classes for priority pill backgrounds. */
export const PRIORITY_STYLES: Record<FacilityIssuePriority, { dot: string; chip: string; label: string }> = {
  critical: { dot: "bg-red-500",    chip: "bg-red-50 text-red-700 ring-red-200",     label: "Critical" },
  high:     { dot: "bg-orange-500", chip: "bg-orange-50 text-orange-700 ring-orange-200", label: "High" },
  medium:   { dot: "bg-amber-500",  chip: "bg-amber-50 text-amber-700 ring-amber-200", label: "Medium" },
  low:      { dot: "bg-slate-400",  chip: "bg-slate-50 text-slate-600 ring-slate-200", label: "Low" },
};

export const STATUS_STYLES: Record<FacilityIssueStatus, { chip: string; label: string }> = {
  new:           { chip: "bg-blue-50 text-blue-700 ring-blue-200",       label: "New" },
  acknowledged:  { chip: "bg-indigo-50 text-indigo-700 ring-indigo-200", label: "Acknowledged" },
  in_progress:   { chip: "bg-purple-50 text-purple-700 ring-purple-200", label: "In Progress" },
  resolved:      { chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Resolved" },
  closed:        { chip: "bg-slate-100 text-slate-600 ring-slate-200",   label: "Closed" },
  reopened:      { chip: "bg-rose-50 text-rose-700 ring-rose-200",       label: "Reopened" },
};

export const SCOPE_LABEL: Record<FacilityScope, string> = {
  it: "IT", hvac: "HVAC", plumbing: "Plumbing", electrical: "Electrical",
  housekeeping: "Housekeeping", security: "Security", other: "Other", facility: "Facility",
};

export const ROOT_CAUSE_LABEL: Record<FacilityRootCause, string> = {
  hardware_failure: "Hardware failure",
  config_issue: "Configuration issue",
  isp_outage: "ISP / internet outage",
  power_issue: "Power issue",
  user_error: "User error",
  scheduled_maintenance: "Scheduled maintenance",
  wear_and_tear: "Wear and tear",
  environmental: "Environmental",
  unknown: "Unknown",
  other: "Other",
};

export const REPORTED_VIA_LABEL: Record<FacilityReportedVia, string> = {
  walk_in: "Walk-in",
  phone: "Phone",
  whatsapp: "WhatsApp",
  email: "Email",
  self_service: "Self-service",
  proactive: "Proactive (IT team)",
  feedback: "Feedback form",
};

/** Lucide-react icon name → emoji fallback used when icon string is unknown. */
export const SCOPE_ICON: Record<FacilityScope, string> = {
  it: "Wifi", hvac: "ThermometerSun", plumbing: "Droplets",
  electrical: "Zap", housekeeping: "Sparkles", security: "ShieldAlert",
  other: "HelpCircle", facility: "Package",
};

/** Compact relative time, e.g. "2h ago", "3d ago". */
export function timeAgo(dateLike: string | Date): string {
  const d = typeof dateLike === "string" ? new Date(dateLike) : dateLike;
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Compact countdown to a future date — "in 4h", "in 2d", or "X overdue" if past. */
export function timeUntil(dateLike: string | Date | null | undefined): string {
  if (!dateLike) return "—";
  const d = typeof dateLike === "string" ? new Date(dateLike) : dateLike;
  const diffSec = Math.floor((d.getTime() - Date.now()) / 1000);
  const overdue = diffSec < 0;
  const a = Math.abs(diffSec);
  let label: string;
  if (a < 60) label = `${a}s`;
  else if (a < 3600) label = `${Math.floor(a / 60)}m`;
  else if (a < 86400) label = `${Math.floor(a / 3600)}h`;
  else label = `${Math.floor(a / 86400)}d`;
  return overdue ? `${label} overdue` : `in ${label}`;
}

/** Format a numeric duration in minutes to "1h 24m" / "45m" / "2d 4h". */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.round((minutes % 1440) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

/** Status-flow guard — what the user is allowed to transition TO from a given state. */
export function nextStatusOptions(current: FacilityIssueStatus): FacilityIssueStatus[] {
  switch (current) {
    case "new":          return ["acknowledged", "in_progress", "resolved"];
    case "acknowledged": return ["in_progress", "resolved"];
    case "in_progress":  return ["resolved"];
    case "resolved":     return ["closed", "reopened"];
    case "closed":       return ["reopened"];
    case "reopened":     return ["acknowledged", "in_progress", "resolved"];
  }
}

export const PRIORITY_LIST: FacilityIssuePriority[] = ["critical", "high", "medium", "low"];
export const STATUS_LIST: FacilityIssueStatus[] = ["new", "acknowledged", "in_progress", "resolved", "closed", "reopened"];
export const ROOT_CAUSE_LIST: FacilityRootCause[] = [
  "hardware_failure", "config_issue", "isp_outage", "power_issue",
  "user_error", "wear_and_tear", "scheduled_maintenance",
  "environmental", "unknown", "other",
];

/** TAT extension reason categories — grouped by whether a resulting breach is exempt from KPI penalty by default. */
export const TAT_REASON_LABEL: Record<FacilityTatReason, string> = {
  vendor_delay: "Vendor non-responsive / delayed",
  awaiting_parts: "Awaiting spare parts",
  dependent_team: "Dependent on another team",
  requester_unavailable: "Requester/tenant unavailable",
  underestimated_effort: "Underestimated effort",
  competing_priorities: "Competing priorities",
  other: "Other",
};

/** true = external/excusable (KPI-exempt by default), false = controllable (counts against KPI if still breached). */
export const TAT_REASON_EXEMPT: Record<FacilityTatReason, boolean> = {
  vendor_delay: true,
  awaiting_parts: true,
  dependent_team: true,
  requester_unavailable: true,
  underestimated_effort: false,
  competing_priorities: false,
  other: false,
};

export const TAT_REASON_LIST_EXEMPT: FacilityTatReason[] = ["vendor_delay", "awaiting_parts", "dependent_team", "requester_unavailable"];
export const TAT_REASON_LIST_CONTROLLABLE: FacilityTatReason[] = ["underestimated_effort", "competing_priorities", "other"];

/** Chip style for a ticket's KPI score badge (shown once a ticket has kpi_points). */
export function kpiPointsStyle(points: number): { className: string; label: string } {
  if (points > 0) return { className: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: `+${points} pts` };
  if (points < 0) return { className: "bg-red-50 text-red-700 ring-red-200", label: `${points} pts` };
  return { className: "bg-slate-50 text-slate-600 ring-slate-200", label: "0 pts" };
}

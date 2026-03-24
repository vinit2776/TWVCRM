"use client";

import { useState, useEffect, useCallback } from "react";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { LocationSelector } from "@/components/shared/location-selector";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import { FollowupsWidget } from "@/components/dashboard/followups-widget";

// Widget components
import { KpiStatsWidget } from "@/components/dashboard/widgets/kpi-stats-widget";
import { RecentActivitiesWidget } from "@/components/dashboard/widgets/recent-activities-widget";
import { NotesWidget } from "@/components/dashboard/widgets/notes-widget";
import { ProcurementSummaryWidget } from "@/components/dashboard/widgets/procurement-summary-widget";
import { SupportSummaryWidget } from "@/components/dashboard/widgets/support-summary-widget";
import { TeamPerformanceWidget } from "@/components/dashboard/widgets/team-performance-widget";
import { BookingSummaryWidget } from "@/components/dashboard/widgets/booking-summary-widget";
import { FinancialSummaryWidget } from "@/components/dashboard/widgets/financial-summary-widget";

import Link from "next/link";
import { Bell, RefreshCw, Zap } from "lucide-react";

import {
  DASHBOARD_ROLE_WIDGETS,
  type WidgetId,
} from "@/lib/dashboard-config";
import type { DashboardStats, UserRole } from "@/types";

async function fetchWidgetConfig(role: UserRole): Promise<WidgetId[]> {
  try {
    const res = await fetch(`/api/settings/dashboard?role=${role}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data as WidgetId[];
    }
  } catch {
    /* fall through */
  }
  return DASHBOARD_ROLE_WIDGETS[role];
}

// ─── Pure utility — defined outside any component ────────────────────────────

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Live Enquiries inline widget (uses context hook) ────────────────────────

function LiveEnquiriesWidget() {
  const {
    newLeadCount,
    reEnquiryCount,
    recentItems,
    markReEnquiriesSeen,
  } = useEnquiryNotifications();

  const newLeadItems = recentItems.filter((i) => i.type === "lead");
  const reEnquiryItems = recentItems.filter((i) => i.type === "activity");
  const hasLiveEnquiries = newLeadCount > 0 || reEnquiryCount > 0;

  if (!hasLiveEnquiries) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-dashed border-muted-foreground/20 text-muted-foreground/60">
        <Zap className="h-4 w-4" />
        <p className="text-xs">No pending new enquiries — you&apos;re all caught up!</p>
      </div>
    );
  }

  return (
    <Card className="border-2 border-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20">
      <div className="p-4 pb-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
            <span className="text-base font-semibold text-emerald-800 dark:text-emerald-200">
              Live Enquiries
            </span>
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-bold text-white">
              {newLeadCount + reEnquiryCount}
            </span>
          </div>
          <Link
            href="/leads?status=new"
            className="text-xs font-medium text-emerald-700 hover:underline underline-offset-2"
          >
            All New Leads →
          </Link>
        </div>

        <div className="space-y-3">
          {newLeadItems.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1.5 flex items-center gap-1">
                <Bell className="h-3 w-3" />
                New Enquiries ({newLeadCount})
              </p>
              <div className="space-y-1">
                {newLeadItems.slice(0, 4).map((item) => (
                  <Link
                    key={item.leadId}
                    href={`/leads/${item.leadId}`}
                    className="flex items-center justify-between rounded-md px-3 py-2 bg-white/80 hover:bg-white transition-colors border border-emerald-100 group"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate group-hover:text-emerald-700 transition-colors">
                        {item.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">#{item.leadId.slice(0, 6)}</span> · {item.source} · {timeAgo(item.time)}
                      </p>
                    </div>
                    <span className="text-xs text-emerald-600 font-medium shrink-0 ml-2">→</span>
                  </Link>
                ))}
                {newLeadCount > 4 && (
                  <p className="text-xs text-emerald-700 text-center pt-1">+{newLeadCount - 4} more</p>
                )}
              </div>
            </div>
          )}

          {reEnquiryItems.length > 0 && (
            <div className={newLeadItems.length > 0 ? "border-t border-emerald-200 pt-3" : ""}>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 flex items-center gap-1">
                  <RefreshCw className="h-3 w-3" />
                  Re-Enquiries ({reEnquiryCount})
                </p>
                {reEnquiryCount > 0 && (
                  <button
                    onClick={markReEnquiriesSeen}
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors hover:underline underline-offset-2"
                  >
                    Mark seen
                  </button>
                )}
              </div>
              <div className="space-y-1">
                {reEnquiryItems.slice(0, 4).map((item, idx) => (
                  <Link
                    key={item.leadId + "-" + idx}
                    href={`/leads/${item.leadId}`}
                    className="flex items-center justify-between rounded-md px-3 py-2 bg-amber-50/80 hover:bg-amber-50 transition-colors border border-amber-100 group"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate group-hover:text-amber-700 transition-colors">
                        {item.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">#{item.leadId.slice(0, 6)}</span> · {item.source} · {timeAgo(item.time)}
                      </p>
                    </div>
                    <span className="text-xs text-amber-600 font-medium shrink-0 ml-2">→</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── Main dashboard page ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [widgetConfig, setWidgetConfig] = useState<WidgetId[]>([]);

  // Fetch role + widget config once on mount
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then(async (json) => {
        const role = (json.role as UserRole) ?? "sales_rep";
        setUserRole(role);
        const widgets = await fetchWidgetConfig(role);
        setWidgetConfig(widgets);
      })
      .catch(() => {
        setUserRole("sales_rep");
        setWidgetConfig(DASHBOARD_ROLE_WIDGETS.sales_rep);
      });
  }, []);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    const params = new URLSearchParams();
    if (locationFilter) params.set("location_id", locationFilter);
    const res = await fetch(`/api/dashboard?${params}`);
    if (res.ok) {
      const json = await res.json();
      setStats(json.data);
    }
    setStatsLoading(false);
  }, [locationFilter]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const widgetIds = widgetConfig;

  // Loading skeleton
  if (!userRole || statsLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <Skeleton className="h-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Map widget ID → rendered component
  function renderWidget(id: WidgetId) {
    switch (id) {
      case "live_enquiries":
        return <LiveEnquiriesWidget key="live_enquiries" />;
      case "kpi_stats":
        return stats ? <KpiStatsWidget key="kpi_stats" stats={stats} /> : null;
      case "followups":
        return <FollowupsWidget key="followups" locationFilter={locationFilter} />;
      case "recent_activities":
        return stats ? <RecentActivitiesWidget key="recent_activities" stats={stats} /> : null;
      case "notes":
        return stats ? <NotesWidget key="notes" stats={stats} /> : null;
      case "procurement_summary":
        return <ProcurementSummaryWidget key="procurement_summary" />;
      case "support_summary":
        return <SupportSummaryWidget key="support_summary" />;
      case "team_performance":
        return <TeamPerformanceWidget key="team_performance" locationFilter={locationFilter} />;
      case "booking_summary":
        return <BookingSummaryWidget key="booking_summary" locationFilter={locationFilter} />;
      case "financial_summary":
        return <FinancialSummaryWidget key="financial_summary" />;
      default:
        return null;
    }
  }

  // live_enquiries and kpi_stats always render full-width outside the grid
  const FULL_WIDTH: WidgetId[] = ["live_enquiries", "kpi_stats"];
  const topWidgets = widgetIds.filter((id) => FULL_WIDTH.includes(id));
  const gridWidgets = widgetIds.filter((id) => !FULL_WIDTH.includes(id));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <LocationSelector
          value={locationFilter}
          onValueChange={setLocationFilter}
          includeAllOption
          placeholder="All Locations"
        />
      </div>

      {/* Full-width widgets */}
      {topWidgets.map((id) => renderWidget(id))}

      {/* Grid widgets */}
      {gridWidgets.length > 0 && (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {gridWidgets.map((id) => renderWidget(id))}
        </div>
      )}
    </div>
  );
}

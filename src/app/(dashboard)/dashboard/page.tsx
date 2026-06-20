"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
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
import { RecentLeadsWidget } from "@/components/dashboard/widgets/recent-leads-widget";
import { RenewalPipelineWidget } from "@/components/dashboard/widgets/renewal-pipeline-widget";
import { CashAgingWidget } from "@/components/dashboard/widgets/cash-aging-widget";
import { RevenuePulseWidget } from "@/components/dashboard/widgets/revenue-pulse-widget";
import { OccupancyWidget } from "@/components/dashboard/widgets/occupancy-widget";
import { SlaRiskWidget } from "@/components/dashboard/widgets/sla-risk-widget";
import { MemberHealthWidget } from "@/components/dashboard/widgets/member-health-widget";
import { LeadFunnelWidget } from "@/components/dashboard/widgets/lead-funnel-widget";
import { ScheduleWidget } from "@/components/dashboard/widgets/schedule-widget";
import { SourceRoiWidget } from "@/components/dashboard/widgets/source-roi-widget";
import { AggregatorPerformanceWidget } from "@/components/dashboard/widgets/aggregator-performance-widget";
import { ProcurementSpendWidget } from "@/components/dashboard/widgets/procurement-spend-widget";
import { QuotaOveruseWidget } from "@/components/dashboard/widgets/quota-overuse-widget";
import { MtdBookingsWidget } from "@/components/dashboard/widgets/mtd-bookings-widget";
import { PendingActionsWidget } from "@/components/dashboard/widgets/pending-actions-widget";
import { RentRevenueWidget } from "@/components/dashboard/widgets/rent-revenue-widget";
import { NetworkWidget } from "@/components/network/network-widget";
import { WeekInReviewWidget } from "@/components/dashboard/widgets/week-in-review-widget";

import Link from "next/link";
import { Zap } from "lucide-react";
import { EnquiryQueueRow } from "@/components/enquiries/enquiry-queue-row";

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
      if (Array.isArray(data) && data.length > 0) {
        const saved = data as WidgetId[];
        const defaults = DASHBOARD_ROLE_WIDGETS[role];
        // Strip widgets removed from defaults; add any newly introduced ones.
        const filtered = saved.filter((w) => (defaults as WidgetId[]).includes(w));
        const missing = defaults.filter((w) => !filtered.includes(w));
        return missing.length > 0 ? [...filtered, ...missing] : filtered;
      }
    }
  } catch {
    /* fall through */
  }
  return DASHBOARD_ROLE_WIDGETS[role];
}

// ─── Live Enquiries inline widget (uses context hook) ────────────────────────

function LiveEnquiriesWidget() {
  const { items, activeCount } = useEnquiryNotifications();

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-dashed border-muted-foreground/20 text-muted-foreground/60">
        <Zap className="h-4 w-4" />
        <p className="text-xs">No pending enquiries — you&apos;re all caught up!</p>
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
              {activeCount}
            </span>
          </div>
          <Link
            href="/leads/enquiry-log"
            className="text-xs font-medium text-emerald-700 hover:underline underline-offset-2"
          >
            Enquiry log →
          </Link>
        </div>

        <div className="space-y-2">
          {items.slice(0, 6).map((item) => (
            <EnquiryQueueRow key={item.leadId} item={item} />
          ))}
          {items.length > 6 && (
            <p className="text-xs text-emerald-700 text-center pt-1">
              +{items.length - 6} more — see <Link href="/leads/enquiry-log" className="underline">enquiry log</Link>
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── Main dashboard page ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const userRole = (user?.role as UserRole) ?? null;
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const [widgetConfig, setWidgetConfig] = useState<WidgetId[]>([]);

  // Fetch widget config once user role is available
  useEffect(() => {
    if (userLoading) return;
    const role = (user?.role as UserRole) ?? "sales_rep";
    fetchWidgetConfig(role).then((widgets) => setWidgetConfig(widgets));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLoading]);

  const fetchStats = useCallback(async () => {
    const params = new URLSearchParams();
    if (locationFilter) params.set("location_id", locationFilter);
    const res = await fetch(`/api/dashboard?${params}`);
    if (res.ok) {
      const json = await res.json();
      setStats(json.data);
    }
  }, [locationFilter]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const widgetIds = widgetConfig;

  // Only block on role/widget config — that's what gates widget layout.
  // Stats-dependent widgets self-render null until stats load; widgets that
  // don't need stats start their own fetches in parallel, so first paint is
  // limited by the slowest widget, not by /api/dashboard alone.
  if (!userRole) {
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
      case "pending_actions":
        return <PendingActionsWidget key="pending_actions" />;
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
      case "recent_leads":
        return <RecentLeadsWidget key="recent_leads" locationFilter={locationFilter} />;
      case "team_performance":
        return <TeamPerformanceWidget key="team_performance" locationFilter={locationFilter} />;
      case "booking_summary":
        return <BookingSummaryWidget key="booking_summary" locationFilter={locationFilter} />;
      case "financial_summary":
        return <FinancialSummaryWidget key="financial_summary" />;
      case "renewal_pipeline":
        return <RenewalPipelineWidget key="renewal_pipeline" locationFilter={locationFilter} />;
      case "cash_aging":
        return <CashAgingWidget key="cash_aging" />;
      case "revenue_pulse":
        return <RevenuePulseWidget key="revenue_pulse" locationFilter={locationFilter} />;
      case "occupancy":
        return <OccupancyWidget key="occupancy" locationFilter={locationFilter} />;
      case "sla_risk":
        return <SlaRiskWidget key="sla_risk" locationFilter={locationFilter} />;
      case "member_health":
        return <MemberHealthWidget key="member_health" />;
      case "lead_funnel":
        return <LeadFunnelWidget key="lead_funnel" locationFilter={locationFilter} />;
      case "schedule":
        return <ScheduleWidget key="schedule" locationFilter={locationFilter} />;
      case "source_roi":
        return <SourceRoiWidget key="source_roi" locationFilter={locationFilter} />;
      case "aggregator_performance":
        return <AggregatorPerformanceWidget key="aggregator_performance" />;
      case "procurement_spend":
        return <ProcurementSpendWidget key="procurement_spend" locationFilter={locationFilter} />;
      case "quota_overuse":
        return <QuotaOveruseWidget key="quota_overuse" />;
      case "mtd_bookings":
        return <MtdBookingsWidget key="mtd_bookings" locationFilter={locationFilter} />;
      case "rent_revenue":
        return <RentRevenueWidget key="rent_revenue" />;
      case "network":
        return <NetworkWidget key="network" locationId={locationFilter ?? undefined} />;
      case "week_in_review":
        return <WeekInReviewWidget key="week_in_review" />;
      default:
        return null;
    }
  }

  // live_enquiries and kpi_stats always render full-width outside the grid
  const FULL_WIDTH: WidgetId[] = ["pending_actions", "live_enquiries", "kpi_stats", "week_in_review"];
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
        <div className="columns-1 md:columns-2 lg:columns-3 gap-6 space-y-6 [&>*]:break-inside-avoid">
          {gridWidgets.map((id) => renderWidget(id))}
        </div>
      )}
    </div>
  );
}

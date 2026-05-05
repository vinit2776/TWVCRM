"use client";

import { Users, TrendingUp, CheckSquare, Clock, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { DashboardStats } from "@/types";

interface KpiStatsWidgetProps {
  stats: DashboardStats;
}

export function KpiStatsWidget({ stats }: KpiStatsWidgetProps) {
  // Total Leads now derives from the unfiltered pipeline so the "all leads in
  // your pipeline" label stays truthful. Conversion below uses the cutoff-
  // filtered numbers (see /api/dashboard CONVERSION_CUTOFF) so the ratio
  // doesn't carry the legacy bulk-imported skew.
  const pipelineTotal = (stats.pipeline ?? []).reduce(
    (sum: number, p: { count: number }) => sum + (p.count ?? 0),
    0,
  );
  const pipelineWon  = (stats.pipeline ?? []).find((p: { status: string }) => p.status === "won")?.count ?? 0;
  const pipelineLost = (stats.pipeline ?? []).find((p: { status: string }) => p.status === "lost")?.count ?? 0;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-1">Total Leads <InfoTooltip text="All leads in your pipeline across all statuses (entire history)" /></CardTitle>
          <Users className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{pipelineTotal}</div>
          <p className="text-xs text-muted-foreground">
            {pipelineWon} won, {pipelineLost} lost
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-1">
            Conversion Rate
            <InfoTooltip text="Top: cumulative since 1 April 2026 (excludes legacy imported leads). Bottom: this-month cohort — of leads created this month, how many have already converted." />
          </CardTitle>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {/* Cumulative since launch — primary number */}
          <div className="text-2xl font-bold">{stats.conversion.rate}%</div>
          <p className="text-[11px] text-muted-foreground">
            {stats.conversion.won}/{stats.conversion.total_leads} since Apr 2026
          </p>
          {/* This-month cohort — secondary, smaller. Always render so layout
              stays stable; show "—" when nothing created this month yet. */}
          {stats.conversion.this_month && (
            <div className="mt-2 pt-2 border-t border-border/60">
              <div className="flex items-baseline gap-1.5">
                <span className="text-base font-semibold">
                  {stats.conversion.this_month.total > 0 ? `${stats.conversion.this_month.rate}%` : "—"}
                </span>
                <span className="text-[11px] text-muted-foreground">this month</span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {stats.conversion.this_month.total > 0
                  ? `${stats.conversion.this_month.won}/${stats.conversion.this_month.total} created in ${new Date().toLocaleDateString("en-IN", { month: "short" })}, won so far`
                  : "No leads created this month yet"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-1">Tasks Due Today <InfoTooltip text="Tasks with a due date of today that need attention" /></CardTitle>
          <CheckSquare className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.tasks_due_today}</div>
          {stats.tasks_overdue > 0 && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {stats.tasks_overdue} overdue
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-1">Pending Follow-ups <InfoTooltip text="Leads with scheduled follow-ups that haven't been completed yet" /></CardTitle>
          <Clock className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.pending_follow_ups}</div>
          <p className="text-xs text-muted-foreground">scheduled follow-ups</p>
        </CardContent>
      </Card>
    </div>
  );
}

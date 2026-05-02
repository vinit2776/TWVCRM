"use client";

/**
 * Facility Dashboard — IT Manager analytics view.
 * Built without chart libraries: uses CSS bars + tables for the
 * same visual outcomes with zero extra dependencies.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { TrendingUp, AlertTriangle, Clock, CheckCircle2, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PRIORITY_STYLES, STATUS_STYLES, formatDuration, timeAgo,
} from "@/lib/facility-ui";
import type {
  FacilityDashboardSummary, FacilityHotSpot, FacilityCategoryBreakdownRow,
  FacilityTrendPoint, FacilityRecurringIssue, FacilityIssue,
} from "@/types";

interface DashboardData {
  summary: FacilityDashboardSummary;
  hot_spots: FacilityHotSpot[];
  by_category: FacilityCategoryBreakdownRow[];
  trend: FacilityTrendPoint[];
  recurring: FacilityRecurringIssue[];
  idle_or_breached: FacilityIssue[];
  period: { from: string; to: string };
}

const PRESETS: Array<{ label: string; days: number }> = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export default function FacilityDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    const dateTo = new Date();
    const dateFrom = new Date(dateTo.getTime() - days * 86400000);
    const res = await fetch(`/api/facility/dashboard?date_from=${dateFrom.toISOString()}&date_to=${dateTo.toISOString()}`);
    const json = await res.json();
    setData(json.data);
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [days]);

  if (loading || !data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading dashboard…</div>;
  }

  const s = data.summary;
  const slaTrend = s.sla_compliance_pct - s.sla_compliance_pct_prev;
  const resolvedTrend = s.resolved_period - s.resolved_period_prev;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Facility Dashboard</h1>
          <p className="text-xs md:text-sm text-muted-foreground">IT infrastructure health across all locations</p>
        </div>
        <div className="flex items-center gap-1 rounded-md bg-muted/40 p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setDays(p.days)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-sm transition",
                days === p.days ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
            >{p.label}</button>
          ))}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          icon={<AlertTriangle className="h-4 w-4 text-red-500" />}
          label="Open issues"
          value={s.open_count}
          sub={`${s.sla_breached_open} SLA-breached`}
          subClass={s.sla_breached_open > 0 ? "text-red-600 font-medium" : ""}
        />
        <KpiCard
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          label="SLA compliance"
          value={`${s.sla_compliance_pct}%`}
          sub={
            <span className={slaTrend >= 0 ? "text-emerald-600" : "text-red-600"}>
              {slaTrend >= 0 ? <ArrowUp className="inline h-3 w-3" /> : <ArrowDown className="inline h-3 w-3" />}
              {Math.abs(slaTrend).toFixed(1)}% vs prev
            </span>
          }
        />
        <KpiCard
          icon={<Clock className="h-4 w-4 text-purple-500" />}
          label="Avg resolution"
          value={formatDuration(s.avg_resolution_minutes)}
          sub={`${data.recurring.length} recurring`}
        />
        <KpiCard
          icon={<TrendingUp className="h-4 w-4 text-blue-500" />}
          label="Resolved"
          value={s.resolved_period}
          sub={
            <span className={resolvedTrend >= 0 ? "text-emerald-600" : "text-red-600"}>
              {resolvedTrend >= 0 ? "+" : ""}{resolvedTrend} vs prev
            </span>
          }
        />
      </div>

      {/* Open by priority strip */}
      <section className="rounded-lg border bg-card p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Open by priority</div>
        <div className="grid grid-cols-4 gap-2">
          {(["critical", "high", "medium", "low"] as const).map((p) => (
            <div key={p} className="rounded-md border p-3 flex items-center gap-3">
              <span className={cn("h-3 w-3 rounded-full", PRIORITY_STYLES[p].dot)} />
              <div>
                <div className="text-xs text-muted-foreground">{PRIORITY_STYLES[p].label}</div>
                <div className="text-lg font-semibold">{s.open_by_priority[p] ?? 0}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Hot spots + Category breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Hot spots — most issues</div>
          {data.hot_spots.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-4">No issues in this period.</p>
          ) : (
            <div className="space-y-2">
              {data.hot_spots.map((h) => {
                const max = data.hot_spots[0].total_issues;
                const pct = (h.total_issues / max) * 100;
                return (
                  <div key={h.location_id}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium truncate">{h.location_name}</span>
                      <span className="text-muted-foreground">{h.total_issues}</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden flex">
                      <PriorityBar w={(h.by_priority.critical / h.total_issues) * pct} cls={PRIORITY_STYLES.critical.dot} />
                      <PriorityBar w={(h.by_priority.high     / h.total_issues) * pct} cls={PRIORITY_STYLES.high.dot} />
                      <PriorityBar w={(h.by_priority.medium   / h.total_issues) * pct} cls={PRIORITY_STYLES.medium.dot} />
                      <PriorityBar w={(h.by_priority.low      / h.total_issues) * pct} cls={PRIORITY_STYLES.low.dot} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Category breakdown by location</div>
          {data.by_category.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-4">No data.</p>
          ) : (
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {data.by_category.map((row) => {
                const total = row.by_category.reduce((a, b) => a + b.count, 0);
                return (
                  <div key={row.location_id}>
                    <div className="text-xs font-medium mb-1">{row.location_name} <span className="text-muted-foreground">({total})</span></div>
                    <div className="h-3 rounded-full bg-muted overflow-hidden flex">
                      {row.by_category.slice(0, 5).map((c, i) => {
                        const colors = ["bg-blue-400", "bg-purple-400", "bg-amber-400", "bg-emerald-400", "bg-rose-400"];
                        return <div key={c.category_id} title={`${c.category_name} (${c.count})`} className={cn("h-full", colors[i])} style={{ width: `${(c.count / total) * 100}%` }} />;
                      })}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1 line-clamp-1">
                      {row.by_category.slice(0, 5).map((c) => `${c.category_name} (${c.count})`).join(" · ")}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Trend */}
      <section className="rounded-lg border bg-card p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Issues per week</div>
        {data.trend.length === 0 ? (
          <p className="text-sm text-muted-foreground italic py-4">No data.</p>
        ) : (
          <div className="flex items-end gap-1 h-32">
            {data.trend.map((t) => {
              const max = Math.max(...data.trend.map((x) => x.total));
              const h = max > 0 ? (t.total / max) * 100 : 0;
              return (
                <div key={t.bucket} className="flex-1 flex flex-col items-center gap-1 group">
                  <div className="w-full bg-[#015E65]/70 hover:bg-[#015E65] rounded-t" style={{ height: `${h}%` }} />
                  <div className="text-[9px] text-muted-foreground hidden md:block">{t.bucket.split("-W").pop()}</div>
                  <div className="opacity-0 group-hover:opacity-100 absolute -mt-8 bg-foreground text-background text-[10px] px-1.5 py-0.5 rounded">{t.total}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recurring + Idle/Breached */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Recurring issues</div>
          {data.recurring.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-4">No recurring patterns detected.</p>
          ) : (
            <div className="space-y-1.5">
              {data.recurring.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-sm p-2 rounded-md hover:bg-muted/30">
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">
                      {r.asset_name ? <>{r.asset_name} <code className="text-[10px] text-muted-foreground font-mono">({r.asset_code})</code></> : r.category_name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{r.location_name} · last {timeAgo(r.last_at)}</div>
                  </div>
                  <span className="text-sm font-semibold text-red-600 shrink-0">{r.count}×</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">SLA-breached open issues</div>
          {data.idle_or_breached.length === 0 ? (
            <p className="text-sm text-emerald-700 italic py-4">All open issues are within SLA. 🎉</p>
          ) : (
            <div className="space-y-1.5">
              {data.idle_or_breached.map((i) => (
                <Link key={i.id} href={`/facility/issues/${i.id}`} className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/30 text-sm">
                  <span className={cn("h-2 w-2 rounded-full shrink-0", PRIORITY_STYLES[i.priority].dot)} />
                  <code className="text-[11px] font-mono text-muted-foreground">{i.issue_number}</code>
                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", STATUS_STYLES[i.status].chip)}>
                    {STATUS_STYLES[i.status].label}
                  </span>
                  <span className="truncate flex-1">{i.title}</span>
                  <span className="text-xs text-red-600 font-medium shrink-0">{timeAgo(i.created_at)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value, sub, subClass }: { icon: React.ReactNode; label: string; value: string | number; sub?: React.ReactNode; subClass?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}<span>{label}</span></div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className={cn("text-xs mt-1 text-muted-foreground", subClass)}>{sub}</div>}
    </div>
  );
}

function PriorityBar({ w, cls }: { w: number; cls: string }) {
  if (w <= 0) return null;
  return <div className={cn("h-full", cls)} style={{ width: `${w}%` }} />;
}

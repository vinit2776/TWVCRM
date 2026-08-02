"use client";

import { use, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/providers/current-user-provider";

interface AuditEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }>;
  created_at: string;
}

interface BreakdownRow {
  entity_type: string;
  action: string;
  count: number;
}

interface ActivityData {
  timeline: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
  breakdown: BreakdownRow[];
  breakdown_truncated: boolean;
  period: { start: string; end: string };
  trend: {
    current_count: number;
    previous_count: number;
    previous_period: { start: string; end: string };
    delta: number;
    delta_pct: number | null;
  };
}

const RANGE_OPTIONS: { value: string; label: string }[] = [
  { value: "hour", label: "Past hour" },
  { value: "day", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
];

const PAGE_SIZE = 20;

const ACTION_COLORS: Record<string, string> = {
  create: "bg-green-100 text-green-800",
  update: "bg-blue-100 text-blue-800",
  delete: "bg-red-100 text-red-800",
  view: "bg-slate-100 text-slate-700",
  login: "bg-purple-100 text-purple-800",
};

/** Format a snake_case string as Title Case for display. */
function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * One-line preview of what changed, shown inline on the collapsed row.
 * Without this, several same-action/same-entity rows in a row (e.g. six
 * "Update · Case Document" events at the same timestamp) are indistinguishable
 * until each is expanded one by one.
 */
function summarizeChanges(changes: Record<string, { old: unknown; new: unknown }>): string {
  const keys = Object.keys(changes || {});
  if (keys.length === 0) return "";
  const shown = keys.slice(0, 3).map((k) => k.replace(/_/g, " "));
  const more = keys.length > 3 ? ` +${keys.length - 3} more` : "";
  return shown.join(", ") + more;
}

function displayValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "object") {
    try {
      const s = JSON.stringify(val);
      return s.length > 120 ? s.slice(0, 117) + "..." : s;
    } catch {
      return String(val);
    }
  }
  const s = String(val);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

export default function UserActivityStoryboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = use(params);
  const { user: currentUser } = useCurrentUser();

  const [targetUser, setTargetUser] = useState<{ full_name: string; role: string } | null>(null);
  const [range, setRange] = useState("month");
  const [data, setData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => json && setTargetUser(json.data))
      .catch(() => {});
  }, [userId]);

  const fetchActivity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        range,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const res = await fetch(`/api/users/${userId}/activity?${params}`);
      if (res.status === 403) {
        setError("You don't have access to this person's activity.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load activity.");
        return;
      }
      const json = await res.json();
      setData(json.data);
    } catch {
      setError("Failed to load activity.");
    } finally {
      setLoading(false);
    }
  }, [userId, range, offset]);

  useEffect(() => {
    setOffset(0);
  }, [range]);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  const isSelf = currentUser?.id === userId;
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const chartData = (data?.breakdown || [])
    .slice(0, 10)
    .map((b) => ({ name: `${titleCase(b.entity_type)} · ${b.action}`, count: b.count }));

  const trend = data?.trend;
  const TrendIcon = !trend || trend.delta === 0 ? Minus : trend.delta > 0 ? TrendingUp : TrendingDown;
  const trendColor = !trend || trend.delta === 0 ? "text-muted-foreground" : trend.delta > 0 ? "text-green-600" : "text-red-600";

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/team"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-lg font-semibold">
            {isSelf ? "My Activity" : targetUser ? `${targetUser.full_name}'s Activity` : "Activity"}
          </h1>
          {targetUser && (
            <p className="text-xs text-muted-foreground">{titleCase(targetUser.role)}</p>
          )}
        </div>
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="h-8 w-[140px] text-xs ml-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      )}

      {!error && loading && !data && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!error && data && (
        <>
          {/* Trend */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Trend</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-6">
              <div>
                <p className="text-2xl font-semibold">{trend?.current_count ?? 0}</p>
                <p className="text-xs text-muted-foreground">events this period</p>
              </div>
              <div className={cn("flex items-center gap-1 text-sm", trendColor)}>
                <TrendIcon className="h-4 w-4" />
                <span>
                  {trend && trend.delta_pct !== null
                    ? `${trend.delta_pct > 0 ? "+" : ""}${trend.delta_pct.toFixed(0)}%`
                    : trend
                    ? `${trend.delta > 0 ? "+" : ""}${trend.delta}`
                    : "—"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground ml-auto">
                vs. {trend?.previous_count ?? 0} in the prior equivalent period
              </p>
            </CardContent>
          </Card>

          {/* Breakdown */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Where time went</CardTitle>
            </CardHeader>
            <CardContent>
              {chartData.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No activity in this period.</p>
              ) : (
                <div style={{ width: "100%", height: Math.max(120, chartData.length * 32) }}>
                  <ResponsiveContainer>
                    <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" allowDecimals={false} fontSize={11} />
                      <YAxis type="category" dataKey="name" width={160} fontSize={11} />
                      <Tooltip />
                      <Bar dataKey="count" fill="var(--chart-1, #3b82f6)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              {data.breakdown_truncated && (
                <p className="text-[10px] text-muted-foreground mt-2">
                  Showing a partial breakdown — activity volume in this period exceeds what&apos;s aggregated per request.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Timeline */}
          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Timeline</CardTitle>
              <span className="text-[10px] text-muted-foreground">
                {data.total} event{data.total !== 1 ? "s" : ""}
              </span>
            </CardHeader>
            <CardContent className="space-y-1">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : data.timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No activity found.</p>
              ) : (
                data.timeline.map((entry) => {
                  const changeKeys = Object.keys(entry.changes || {});
                  const expanded = expandedId === entry.id;
                  const clickable = changeKeys.length > 0;
                  const summary = summarizeChanges(entry.changes);
                  return (
                    <div key={entry.id} className="rounded-md border bg-muted/10 overflow-hidden">
                      <div
                        className={cn(
                          "flex items-start gap-2 px-2 py-2 transition-colors",
                          clickable && "cursor-pointer hover:bg-muted/30",
                          expanded && "bg-muted/20"
                        )}
                        onClick={() => clickable && setExpandedId(expanded ? null : entry.id)}
                      >
                        <div className="pt-0.5 w-3.5 shrink-0">
                          {clickable && (
                            <ChevronDown
                              className={cn(
                                "h-3 w-3 text-muted-foreground transition-transform duration-150",
                                expanded && "rotate-180"
                              )}
                            />
                          )}
                        </div>
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge
                              variant="outline"
                              className={`text-[9px] px-1 py-0 h-4 font-semibold uppercase ${
                                ACTION_COLORS[entry.action] || "bg-gray-100 text-gray-700"
                              }`}
                            >
                              {entry.action}
                            </Badge>
                            <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">
                              {titleCase(entry.entity_type)}
                            </Badge>
                            {!expanded && summary && (
                              <span className="text-[10px] text-muted-foreground truncate">
                                {summary}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            {formatDateTime(entry.created_at)}
                            {!clickable && (
                              <span className="ml-1.5 opacity-70">· {entry.entity_id.slice(0, 8)}</span>
                            )}
                          </p>
                        </div>
                      </div>
                      {expanded && changeKeys.length > 0 && (
                        <div className="border-t bg-muted/5 px-3 py-2 space-y-1.5">
                          {changeKeys.map((key) => {
                            const change = entry.changes[key];
                            return (
                              <div key={key} className="rounded bg-background border px-2 py-1.5 space-y-0.5">
                                <p className="text-[10px] font-medium text-foreground">{titleCase(key)}</p>
                                <div className="flex items-start gap-1.5 text-[10px]">
                                  <span className="text-red-600 bg-red-50 rounded px-1 py-0.5 max-w-[45%] break-words">
                                    {displayValue(change.old)}
                                  </span>
                                  <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                                  <span className="text-green-700 bg-green-50 rounded px-1 py-0.5 max-w-[45%] break-words">
                                    {displayValue(change.new)}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2 border-t">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    <ChevronLeft className="h-3 w-3 mr-1" />
                    Prev
                  </Button>
                  <span className="text-[10px] text-muted-foreground">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={offset + PAGE_SIZE >= data.total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                    <ChevronRight className="h-3 w-3 ml-1" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

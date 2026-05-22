"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  DoorOpen,
  ShieldAlert,
  TrendingUp,
  RefreshCw,
  Clock,
  CalendarDays,
  AlertTriangle,
  Repeat2,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────

type Location = { id: string; name: string };

type TodayVisitor = {
  entity_id: string | null;
  entity_name: string;
  user_type: string;
  first_entry_at: string;
  entries_today: number;
};

type AttendanceRow = {
  entity_id: string;
  entity_name: string;
  user_type: string;
  unique_days: number;
  total_entries: number;
  first_seen: string;
  last_seen: string;
};

type DenialSummaryRow = {
  entity_id: string | null;
  entity_name: string;
  user_type: string | null;
  count: number;
  reasons: Record<string, number>;
  last_denied_at: string;
};

type HeatmapCell = { day: number; hour: number; count: number };
type FootfallPoint = { date: string; label: string; count: number };

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEATMAP_COLORS = ["#f0f9ff", "#bae6fd", "#7dd3fc", "#0ea5e9", "#0369a1"];

const USER_TYPE_COLORS: Record<string, string> = {
  contract: "bg-blue-100 text-blue-700",
  member:   "bg-purple-100 text-purple-700",
  employee: "bg-green-100 text-green-700",
  booking:  "bg-amber-100 text-amber-700",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function heatColor(count: number, max: number): string {
  if (count === 0) return HEATMAP_COLORS[0];
  const idx = Math.ceil((count / max) * (HEATMAP_COLORS.length - 1));
  return HEATMAP_COLORS[Math.min(idx, HEATMAP_COLORS.length - 1)];
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function utilizationLabel(pct: number): { label: string; color: string } {
  if (pct >= 50) return { label: "Active",    color: "text-green-600" };
  if (pct >= 20) return { label: "Moderate",  color: "text-amber-600" };
  return              { label: "Low — at risk", color: "text-red-600" };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AccessAnalyticsPage() {
  const [locations, setLocations]   = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>("__all");
  const [days, setDays]             = useState(30);
  const [loading, setLoading]       = useState(false);

  // Data state
  const [todayData, setTodayData]         = useState<{ data: TodayVisitor[]; total_entries: number; unique_visitors: number } | null>(null);
  const [attendance, setAttendance]       = useState<AttendanceRow[]>([]);
  const [denialSummary, setDenialSummary] = useState<DenialSummaryRow[]>([]);
  const [heatmap, setHeatmap]             = useState<HeatmapCell[]>([]);
  const [heatmapMax, setHeatmapMax]       = useState(1);
  const [footfall, setFootfall]           = useState<FootfallPoint[]>([]);

  // Locations
  useEffect(() => {
    fetch("/api/locations?minimal=true")
      .then(r => r.json())
      .then(d => setLocations(d.data ?? d ?? []))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const loc  = locationId !== "__all" ? `&location_id=${locationId}` : "";
    const dp   = `&days=${days}`;

    try {
      const [todayRes, attRes, denRes, hmRes, ffRes] = await Promise.all([
        fetch(`/api/cosec/analytics?type=today${loc}`),
        fetch(`/api/cosec/analytics?type=attendance${loc}${dp}`),
        fetch(`/api/cosec/analytics?type=denials${loc}${dp}`),
        fetch(`/api/cosec/analytics?type=heatmap${loc}${dp}`),
        fetch(`/api/cosec/analytics?type=footfall${loc}${dp}`),
      ]);

      const [todayJson, attJson, denJson, hmJson, ffJson] = await Promise.all([
        todayRes.json(), attRes.json(), denRes.json(), hmRes.json(), ffRes.json(),
      ]);

      setTodayData(todayJson);
      setAttendance(attJson.data ?? []);
      setDenialSummary(denJson.summary ?? []);
      setHeatmap(hmJson.data ?? []);
      setHeatmapMax(hmJson.maxCount ?? 1);
      setFootfall(ffJson.data ?? []);
    } finally {
      setLoading(false);
    }
  }, [locationId, days]);

  useEffect(() => { load(); }, [load]);

  // Day-of-week bar from heatmap
  const dowData = DAYS.map((label, i) => ({
    day: label,
    entries: heatmap.filter(c => c.day === i).reduce((s, c) => s + c.count, 0),
  }));

  // Peak hour (single value for KPI)
  const peakHour = (() => {
    if (heatmap.length === 0) return null;
    const byHour = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      count: heatmap.filter(c => c.hour === h).reduce((s, c) => s + c.count, 0),
    }));
    const peak = byHour.reduce((best, cur) => cur.count > best.count ? cur : best, byHour[0]);
    if (peak.count === 0) return null;
    const h = peak.hour;
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}–${(h12 % 12) + 1} ${suffix}`;
  })();

  // Tick interval for footfall chart (avoid crowding)
  const ffInterval = footfall.length <= 10 ? 0
    : footfall.length <= 21 ? 2
    : footfall.length <= 45 ? 6
    : 13;

  // Members with re-entries today
  const reEntryToday = (todayData?.data ?? []).filter(v => v.entries_today > 1);

  // Attendance enriched with utilisation %
  const attendanceWithUtil = attendance.map(a => ({
    ...a,
    util_pct: Math.min(Math.round((a.unique_days / days) * 100), 100),
    re_entries: a.total_entries - a.unique_days,
  })).sort((a, b) => a.util_pct - b.util_pct); // at-risk first

  const totalDenials = denialSummary.reduce((s, r) => s + r.count, 0);

  return (
    <div className="p-6 space-y-6">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Access Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Entry-based insights — sensor on entry side only, exit button has no reader
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger className="w-44 h-8 text-sm">
              <SelectValue placeholder="All Locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All Locations</SelectItem>
              {locations.map(l => (
                <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1">
            {[7, 14, 30, 90].map(d => (
              <Button key={d} size="sm" variant={days === d ? "default" : "outline"}
                className="h-8 px-2.5 text-xs" onClick={() => setDays(d)}>
                {d}d
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" className="h-8" onClick={load} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {/* ── KPIs ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <DoorOpen size={13} /> Entries Today
            </div>
            <p className="text-2xl font-bold">{todayData?.total_entries ?? "—"}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {todayData ? `${todayData.unique_visitors} unique visitor${todayData.unique_visitors !== 1 ? "s" : ""}` : ""}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Clock size={13} /> Peak Hour ({days}d)
            </div>
            <p className="text-2xl font-bold">{peakHour ?? "—"}</p>
            <p className="text-xs text-muted-foreground mt-0.5">most entries IST</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <TrendingUp size={13} /> Active ({days}d)
            </div>
            <p className="text-2xl font-bold">{attendance.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">unique entities</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <ShieldAlert size={13} /> Denials ({days}d)
            </div>
            <p className="text-2xl font-bold text-red-600">{totalDenials}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {denialSummary.length} entity{denialSummary.length !== 1 ? "ies" : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Today's Visitors + Footfall Trend ────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Today's Visitors */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users size={14} />
              Today&apos;s Visitors ({todayData?.unique_visitors ?? 0})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {(todayData?.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground px-4 pb-4">No entries recorded yet today.</p>
            ) : (
              <div className="divide-y max-h-80 overflow-y-auto">
                {(todayData?.data ?? []).map((v, i) => (
                  <div key={v.entity_id ?? i} className="px-4 py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{v.entity_name}</p>
                      <p className="text-xs text-muted-foreground">
                        First in {fmtTime(v.first_entry_at)}
                        {v.entries_today > 1 && (
                          <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-600">
                            <Repeat2 size={10} /> {v.entries_today}×
                          </span>
                        )}
                      </p>
                    </div>
                    <Badge
                      className={`text-xs shrink-0 ${USER_TYPE_COLORS[v.user_type] ?? "bg-gray-100 text-gray-600"}`}
                      variant="outline"
                    >
                      {v.user_type}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Daily Footfall Trend */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <CalendarDays size={14} /> Daily Footfall (last {days}d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {footfall.length === 0 ? (
              <p className="text-xs text-muted-foreground">No entry data in this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={footfall} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10 }}
                    interval={ffInterval}
                    angle={footfall.length > 14 ? -35 : 0}
                    textAnchor={footfall.length > 14 ? "end" : "middle"}
                    height={footfall.length > 14 ? 40 : 20}
                  />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => [`${v} entries`, "Footfall"]} />
                  <Bar dataKey="count" fill="#0ea5e9" radius={[3, 3, 0, 0]} name="Entries" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Peak Hours Heatmap ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock size={14} /> Peak Hours Heatmap (last {days}d — IST)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-separate" style={{ borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th className="w-10 text-left text-muted-foreground font-normal pr-2" />
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} className="text-center text-muted-foreground font-normal" style={{ minWidth: 26 }}>
                      {h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((day, di) => (
                  <tr key={di}>
                    <td className="text-right text-muted-foreground pr-2 font-normal">{day}</td>
                    {Array.from({ length: 24 }, (_, hi) => {
                      const cell = heatmap.find(c => c.day === di && c.hour === hi);
                      const count = cell?.count ?? 0;
                      return (
                        <td
                          key={hi}
                          title={`${day} ${hi}:00 — ${count} entries`}
                          className="rounded"
                          style={{ backgroundColor: heatColor(count, heatmapMax), height: 20, minWidth: 26 }}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
              <span>Low</span>
              {HEATMAP_COLORS.map(c => (
                <span key={c} className="w-5 h-3 rounded inline-block" style={{ backgroundColor: c }} />
              ))}
              <span>High</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Day-of-Week Pattern + Re-entries Today ────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* DOW Pattern */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <CalendarDays size={14} /> Day-of-Week Pattern (last {days}d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={dowData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => [`${v} entries`, "Total"]} />
                <Bar dataKey="entries" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Re-entries today */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Repeat2 size={14} /> Re-entries Today
              <span className="text-xs font-normal text-muted-foreground ml-1">
                — entered more than once
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {reEntryToday.length === 0 ? (
              <p className="text-xs text-muted-foreground px-4 pb-4">
                No re-entries today — everyone came in once.
              </p>
            ) : (
              <div className="divide-y max-h-64 overflow-y-auto">
                {reEntryToday.map((v, i) => (
                  <div key={v.entity_id ?? i} className="px-4 py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{v.entity_name}</p>
                      <p className="text-xs text-muted-foreground">First in {fmtTime(v.first_entry_at)}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge className={`text-xs ${USER_TYPE_COLORS[v.user_type] ?? ""}`} variant="outline">
                        {v.user_type}
                      </Badge>
                      <span className="text-xs font-semibold text-amber-600 flex items-center gap-0.5">
                        <Repeat2 size={11} /> {v.entries_today}× today
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Member Utilisation + Access Denials ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Member Utilisation */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp size={14} /> Member Utilisation (last {days}d)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {attendanceWithUtil.length === 0 ? (
              <p className="text-xs text-muted-foreground px-4 pb-4">No attendance data in this period.</p>
            ) : (
              <div className="divide-y max-h-96 overflow-y-auto">
                {attendanceWithUtil.map(a => {
                  const { label, color } = utilizationLabel(a.util_pct);
                  return (
                    <div key={a.entity_id} className="px-4 py-2.5">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-sm font-medium truncate">{a.entity_name}</p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {a.util_pct < 20 && (
                            <AlertTriangle size={12} className="text-red-500" />
                          )}
                          <Badge
                            className={`text-xs ${USER_TYPE_COLORS[a.user_type] ?? "bg-gray-100 text-gray-600"}`}
                            variant="outline"
                          >
                            {a.user_type}
                          </Badge>
                          <span className="text-xs font-semibold">{a.util_pct}%</span>
                        </div>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5 mb-1">
                        <div
                          className={`h-1.5 rounded-full ${
                            a.util_pct >= 50 ? "bg-green-500"
                            : a.util_pct >= 20 ? "bg-amber-400"
                            : "bg-red-400"
                          }`}
                          style={{ width: `${a.util_pct}%` }}
                        />
                      </div>
                      <p className={`text-xs ${color}`}>
                        {label} · {a.unique_days}d of {days} · {a.total_entries} entries
                        {a.re_entries > 0 && ` · ${a.re_entries} re-entries`}
                        {" · "} Last: {fmtDateTime(a.last_seen)}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Access Denials */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <ShieldAlert size={14} /> Access Denials (last {days}d)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {denialSummary.length === 0 ? (
              <p className="text-xs text-muted-foreground px-4 pb-4">No denial events in this period.</p>
            ) : (
              <div className="divide-y max-h-96 overflow-y-auto">
                {denialSummary.slice(0, 20).map((d, i) => (
                  <div key={d.entity_id ?? i} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-sm font-medium truncate">{d.entity_name}</p>
                      <Badge variant="destructive" className="text-xs shrink-0">{d.count}×</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(d.reasons).map(([reason, cnt]) => (
                        <span key={reason} className="text-xs bg-red-50 text-red-700 border border-red-200 rounded px-1.5 py-0.5">
                          {reason} ({cnt})
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Last: {fmtDateTime(d.last_denied_at)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

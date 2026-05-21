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
  Building2,
  Clock,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────

type Location = { id: string; name: string };
type PresenceRow = {
  entity_id: string;
  entity_name: string;
  user_type: string;
  is_inside: boolean;
  last_entry_at: string | null;
  last_exit_at: string | null;
  device: { label: string; location: { name: string } | null } | null;
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

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEATMAP_COLORS = ["#f0f9ff", "#bae6fd", "#7dd3fc", "#0ea5e9", "#0369a1"];

function heatColor(count: number, max: number): string {
  if (count === 0) return HEATMAP_COLORS[0];
  const idx = Math.ceil((count / max) * (HEATMAP_COLORS.length - 1));
  return HEATMAP_COLORS[Math.min(idx, HEATMAP_COLORS.length - 1)];
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const USER_TYPE_COLORS: Record<string, string> = {
  contract: "bg-blue-100 text-blue-700",
  member:   "bg-purple-100 text-purple-700",
  employee: "bg-green-100 text-green-700",
  booking:  "bg-amber-100 text-amber-700",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AccessAnalyticsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>("__all");
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);

  // Analytics state
  const [presence, setPresence] = useState<PresenceRow[]>([]);
  const [presenceSummary, setPresenceSummary] = useState<{ total: number; inside: number; outside: number } | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [denialSummary, setDenialSummary] = useState<DenialSummaryRow[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
  const [heatmapMax, setHeatmapMax] = useState(1);

  // Load locations
  useEffect(() => {
    fetch("/api/locations?minimal=true")
      .then(r => r.json())
      .then(d => setLocations(d.data ?? d ?? []))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const locParam = locationId !== "__all" ? `&location_id=${locationId}` : "";
    const daysParam = `&days=${days}`;

    try {
      const [presRes, attRes, denRes, hmRes] = await Promise.all([
        fetch(`/api/cosec/analytics?type=presence${locParam}`),
        fetch(`/api/cosec/analytics?type=attendance${locParam}${daysParam}`),
        fetch(`/api/cosec/analytics?type=denials${locParam}${daysParam}`),
        fetch(`/api/cosec/analytics?type=heatmap${locParam}${daysParam}`),
      ]);

      const [presData, attData, denData, hmData] = await Promise.all([
        presRes.json(), attRes.json(), denRes.json(), hmRes.json(),
      ]);

      setPresence(presData.data ?? []);
      setPresenceSummary(presData.summary ?? null);
      setAttendance(attData.data ?? []);
      setDenialSummary(denData.summary ?? []);
      setHeatmap(hmData.data ?? []);
      setHeatmapMax(hmData.maxCount ?? 1);
    } finally {
      setLoading(false);
    }
  }, [locationId, days]);

  useEffect(() => { load(); }, [load]);

  // Build daily bar chart from heatmap data (collapse hours → day totals)
  const dailyData = DAYS.map((label, dayIdx) => {
    const count = heatmap.filter(c => c.day === dayIdx).reduce((s, c) => s + c.count, 0);
    return { day: label, entries: count };
  });

  const insideNow = presence.filter(p => p.is_inside);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Access Analytics</h1>
          <p className="text-sm text-muted-foreground">Live presence & historical access insights across all locations</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Location filter */}
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

          {/* Days filter */}
          <div className="flex gap-1">
            {[7, 14, 30, 90].map(d => (
              <Button
                key={d}
                size="sm"
                variant={days === d ? "default" : "outline"}
                className="h-8 px-2.5 text-xs"
                onClick={() => setDays(d)}
              >
                {d}d
              </Button>
            ))}
          </div>

          <Button size="sm" variant="outline" className="h-8" onClick={load} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Users size={13} /> Total Tracked
            </div>
            <p className="text-2xl font-bold">{presenceSummary?.total ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <DoorOpen size={13} /> Inside Now
            </div>
            <p className="text-2xl font-bold text-green-600">{presenceSummary?.inside ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <TrendingUp size={13} /> Active ({days}d)
            </div>
            <p className="text-2xl font-bold">{attendance.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <ShieldAlert size={13} /> Denials ({days}d)
            </div>
            <p className="text-2xl font-bold text-red-600">
              {denialSummary.reduce((s, r) => s + r.count, 0)}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Live Presence */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Inside Right Now ({insideNow.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {insideNow.length === 0 ? (
              <p className="text-xs text-muted-foreground px-4 pb-4">No one tracked inside currently.</p>
            ) : (
              <div className="divide-y max-h-80 overflow-y-auto">
                {insideNow.map(p => (
                  <div key={`${p.entity_id}-${p.device?.label}`} className="px-4 py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{p.entity_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.device?.location?.name ?? p.device?.label ?? "Unknown"} · {fmtTime(p.last_entry_at)}
                      </p>
                    </div>
                    <Badge className={`text-xs shrink-0 ${USER_TYPE_COLORS[p.user_type] ?? ""}`} variant="outline">
                      {p.user_type}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Daily Entry Chart */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Building2 size={14} /> Entries by Day of Week (last {days}d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dailyData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="entries" fill="#0ea5e9" radius={[3, 3, 0, 0]} name="Entries" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Peak Hours Heatmap */}
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
                    <th key={h} className="text-center text-muted-foreground font-normal" style={{ minWidth: 28 }}>
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
                          style={{
                            backgroundColor: heatColor(count, heatmapMax),
                            height: 20,
                            minWidth: 28,
                          }}
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Attendance Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp size={14} /> Top Attendees (last {days}d)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {attendance.length === 0 ? (
              <p className="text-xs text-muted-foreground px-4 pb-4">No attendance data for this period.</p>
            ) : (
              <div className="divide-y max-h-96 overflow-y-auto">
                {attendance.slice(0, 20).map(a => (
                  <div key={a.entity_id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-sm font-medium truncate">{a.entity_name}</p>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge className={`text-xs ${USER_TYPE_COLORS[a.user_type] ?? ""}`} variant="outline">
                          {a.user_type}
                        </Badge>
                        <span className="text-xs font-semibold">{a.unique_days}d</span>
                      </div>
                    </div>
                    <div className="w-full bg-muted rounded-full h-1.5">
                      <div
                        className="bg-blue-500 h-1.5 rounded-full"
                        style={{ width: `${Math.round((a.unique_days / days) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {a.total_entries} entries · Last: {fmtTime(a.last_seen)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Denial Flags */}
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
                    <p className="text-xs text-muted-foreground mt-0.5">Last: {fmtTime(d.last_denied_at)}</p>
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

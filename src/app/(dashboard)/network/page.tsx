"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Wifi, RefreshCw, Server, Users, Activity, MonitorSmartphone,
  Signal, Globe, ChevronLeft, ChevronRight, Settings2, Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function signalBar(signal: number): string {
  // signal is negative dBm; closer to 0 = stronger
  if (signal >= -55) return "▂▄▆█";
  if (signal >= -65) return "▂▄▆ ";
  if (signal >= -75) return "▂▄  ";
  return "▂   ";
}

const PAGE_SIZE = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Location {
  id: string;
  name: string;
  unifi_site_id?: string | null;
  unifi_console_id?: string | null;
  wifi_voucher_mode?: string | null;
}

interface DashboardData {
  internet: {
    status: string;
    latency: number | null;       // ms, from API
    uptime: number | null;        // seconds, from API
    isp_name: string | null;
    xput_up: number | null;
    xput_down: number | null;
  };
  live_clients: { total: number; guest: number; staff: number };
  today: { unique_devices: number; wlan_bytes: number; wan_tx: number; wan_rx: number };
}

interface OccupancyClient {
  mac: string; hostname: string; ip: string; essid: string;
  signal: number; uptime: number; is_guest: boolean; ap_mac: string;
}

interface StatsPoint {
  timestamp: string; label: string;
  wlan_users: number; wan_tx_bytes: number; wan_rx_bytes: number; wlan_bytes: number;
}

interface AccessPoint {
  _id: string; name: string; ip: string; model: string; status: string;
  uptime_human: string; clients: number; tx_bytes: number; rx_bytes: number;
  satisfaction: number;
}

interface GuestSession {
  _id: string; mac: string; hostname: string; essid: string; ip: string;
  bytes: number; duration_minutes: number; start: string; voucher_code: string;
}

interface KnownDevice {
  mac: string; hostname: string; note: string; is_guest: boolean;
  first_seen: string; last_seen: string;
}

interface NetworkConfig {
  port_forwards: { id: string; name: string; proto: string; src_port: number; dst_port: number; dst_ip: string; }[];
  wlans: { id: string; name: string; security: string; enabled: boolean; }[];
}

// ─── Tab definitions ──────────────────────────────────────────────────────────

type Tab = "overview" | "visitors" | "bandwidth" | "sessions" | "devices" | "infrastructure" | "configuration";

const TABS: { id: Tab; label: string; icon: React.ElementType; adminOnly?: boolean }[] = [
  { id: "overview",        label: "Overview",        icon: Activity },
  { id: "visitors",        label: "Visitors",        icon: Users },
  { id: "bandwidth",       label: "Bandwidth",       icon: Globe },
  { id: "sessions",        label: "Sessions",        icon: Wifi },
  { id: "devices",         label: "Devices",         icon: MonitorSmartphone },
  { id: "infrastructure",  label: "Infrastructure",  icon: Server },
  { id: "configuration",   label: "Configuration",   icon: Settings2, adminOnly: true },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NetworkPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>("");
  const [userRole, setUserRole] = useState<string | null>(null);

  // Load locations + user role on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/locations").then((r) => r.json()),
      fetch("/api/me").then((r) => r.json()),
    ]).then(([locJson, meJson]) => {
      // For Configuration tab: include ALL active locations.
      // For live-data tabs: only locations with unifi_site_id are usable,
      // but we still show all in the selector so admins can configure them.
      const allLocs: Location[] = locJson.data ?? locJson ?? [];
      setLocations(allLocs);
      // Default selection: prefer first Unifi-enabled location, fall back to first
      const firstUnifi = allLocs.find((l) => l.unifi_site_id);
      if (firstUnifi) setLocationId(firstUnifi.id);
      else if (allLocs.length > 0) setLocationId(allLocs[0].id);
      setUserRole(meJson.role ?? null);
    }).catch(() => {});
  }, []);

  const isInfraRole = userRole
    ? ["admin", "it_manager", "it_technician"].includes(userRole)
    : false;

  const isAdmin = userRole === "admin";

  const selectedLocation = locations.find((l) => l.id === locationId) ?? null;
  const selectedHasUnifi = Boolean(selectedLocation?.unifi_site_id);

  if (locations.length === 0 && locationId === "") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wifi className="h-6 w-6" /> Network
        </h1>
        <p className="text-muted-foreground">No locations configured.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wifi className="h-6 w-6 text-primary" /> Network
        </h1>
        {locations.length > 1 && (
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto border-b pb-0">
        {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {locationId && (
        <div className="min-h-[400px]">
          {tab === "configuration" ? (
            <ConfigurationTab
              locationId={locationId}
              location={selectedLocation}
              onSaved={(updated) =>
                setLocations((prev) => prev.map((l) => (l.id === updated.id ? { ...l, ...updated } : l)))
              }
            />
          ) : !selectedHasUnifi ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
              <Wifi className="h-10 w-10 opacity-30" />
              <p className="text-sm">This location does not have a UniFi site configured yet.</p>
              {isAdmin && (
                <button
                  onClick={() => setTab("configuration")}
                  className="text-sm text-primary underline underline-offset-2 mt-1"
                >
                  Go to Configuration to set it up
                </button>
              )}
            </div>
          ) : (
            <>
              {tab === "overview"       && <OverviewTab locationId={locationId} />}
              {tab === "visitors"       && <VisitorsTab locationId={locationId} />}
              {tab === "bandwidth"      && <BandwidthTab locationId={locationId} />}
              {tab === "sessions"       && <SessionsTab locationId={locationId} />}
              {tab === "devices"        && <DevicesTab locationId={locationId} />}
              {tab === "infrastructure" && <InfrastructureTab locationId={locationId} isInfraRole={isInfraRole} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ locationId }: { locationId: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/unifi/dashboard?location_id=${locationId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setData(json);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  if (!data) return null;

  const online = data.internet.status === "online";

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Internet status */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Internet</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className={`inline-flex h-2.5 w-2.5 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`} />
              <span className={`text-lg font-bold ${online ? "text-green-700" : "text-red-600"}`}>
                {online ? "Online" : "Degraded"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {data.internet.uptime != null
                ? `Up ${Math.floor(data.internet.uptime / 86400)}d ${Math.floor((data.internet.uptime % 86400) / 3600)}h`
                : "Uptime unknown"}
              {data.internet.latency != null && data.internet.latency > 0 && ` · ${data.internet.latency}ms`}
            </p>
          </CardContent>
        </Card>

        {/* Live clients */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Live Clients</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{data.live_clients.total}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {data.live_clients.staff} staff · {data.live_clients.guest} guest
            </p>
          </CardContent>
        </Card>

        {/* Unique devices today */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Devices Today</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{data.today.unique_devices}</p>
            <p className="text-xs text-muted-foreground mt-1">Unique devices seen</p>
          </CardContent>
        </Card>

        {/* Bandwidth today */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Bandwidth Today</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{fmtBytes(data.today.wan_tx + data.today.wan_rx)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              ↑ {fmtBytes(data.today.wan_tx)} · ↓ {fmtBytes(data.today.wan_rx)}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Visitors Tab ─────────────────────────────────────────────────────────────

function VisitorsTab({ locationId }: { locationId: string }) {
  const [stats, setStats] = useState<StatsPoint[]>([]);
  const [clients, setClients] = useState<OccupancyClient[]>([]);
  const [occStats, setOccStats] = useState<{ total: number; guest: number; staff: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, occRes] = await Promise.all([
        fetch(`/api/unifi/stats?location_id=${locationId}&range=hourly&days=1`),
        fetch(`/api/unifi/occupancy?location_id=${locationId}`),
      ]);
      const [statsJson, occJson] = await Promise.all([statsRes.json(), occRes.json()]);
      if (!statsRes.ok) throw new Error(statsJson.error || "Failed to load stats");
      if (!occRes.ok) throw new Error(occJson.error || "Failed to load occupancy");
      setStats(statsJson.data ?? []);
      setClients(occJson.data ?? []);
      setOccStats(occJson.stats ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-6">
      {/* Hourly chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Unique Visitors — Last 24h</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={stats} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <defs>
                <linearGradient id="visitorGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area
                type="monotone" dataKey="wlan_users" name="WiFi Users"
                stroke="#6366f1" fill="url(#visitorGrad)" strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Live occupancy table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold flex items-center justify-between">
            <span>Live Clients</span>
            {occStats && (
              <span className="text-xs font-normal text-muted-foreground">
                {occStats.total} total · {occStats.staff} staff · {occStats.guest} guest
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {clients.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">No clients connected</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-2.5 text-left font-medium">MAC</th>
                    <th className="px-4 py-2.5 text-left font-medium">Hostname</th>
                    <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">SSID</th>
                    <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Signal</th>
                    <th className="px-4 py-2.5 text-left font-medium hidden lg:table-cell">Uptime</th>
                    <th className="px-4 py-2.5 text-left font-medium">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c, i) => (
                    <tr key={i} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-xs">{c.mac}</td>
                      <td className="px-4 py-2.5">{c.hostname || "—"}</td>
                      <td className="px-4 py-2.5 hidden sm:table-cell text-muted-foreground">{c.essid}</td>
                      <td className="px-4 py-2.5 hidden md:table-cell font-mono text-xs text-muted-foreground">
                        {signalBar(c.signal)} {c.signal} dBm
                      </td>
                      <td className="px-4 py-2.5 hidden lg:table-cell text-xs text-muted-foreground">
                        {Math.floor(c.uptime / 60)}m
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant="secondary" className={c.is_guest ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-800"}>
                          {c.is_guest ? "Guest" : "Staff"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Bandwidth Tab ────────────────────────────────────────────────────────────

function BandwidthTab({ locationId }: { locationId: string }) {
  const [range, setRange] = useState<"hourly" | "daily">("hourly");
  const [days, setDays] = useState("7");
  const [stats, setStats] = useState<StatsPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/unifi/stats?location_id=${locationId}&range=${range}&days=${days}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setStats(json.data ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load bandwidth");
    } finally {
      setLoading(false);
    }
  }, [locationId, range, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={range} onValueChange={(v) => setRange(v as "hourly" | "daily")}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hourly">Hourly</SelectItem>
            <SelectItem value="daily">Daily</SelectItem>
          </SelectContent>
        </Select>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last 1 day</SelectItem>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {loading ? (
        <Skeleton className="h-64" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">WAN Bandwidth</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={stats} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="txGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="rxGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v: number) => fmtBytes(v)} tick={{ fontSize: 10 }} width={65} />
                <Tooltip formatter={(v: number | string | undefined) => v != null ? fmtBytes(Number(v)) : "—"} />
                <Legend />
                <Area
                  type="monotone" dataKey="wan_tx_bytes" name="Upload"
                  stroke="#10b981" fill="url(#txGrad)" strokeWidth={2}
                />
                <Area
                  type="monotone" dataKey="wan_rx_bytes" name="Download"
                  stroke="#6366f1" fill="url(#rxGrad)" strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Sessions Tab ─────────────────────────────────────────────────────────────

function SessionsTab({ locationId }: { locationId: string }) {
  const [sessions, setSessions] = useState<GuestSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/unifi/guest-sessions?location_id=${locationId}&page=${page}&per_page=${PAGE_SIZE}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setSessions(json.data ?? []);
      setTotal(json.total ?? 0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [locationId, page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{total} total sessions</p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {loading ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2.5 text-left font-medium">MAC</th>
                  <th className="px-3 py-2.5 text-left font-medium">Hostname</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">SSID</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden md:table-cell">Data Used</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden md:table-cell">Duration</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Started</th>
                  <th className="px-3 py-2.5 text-left font-medium">Voucher</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      No guest sessions found
                    </td>
                  </tr>
                ) : sessions.map((s) => (
                  <tr key={s._id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs">{s.mac}</td>
                    <td className="px-3 py-2.5">{s.hostname || "—"}</td>
                    <td className="px-3 py-2.5 hidden sm:table-cell text-muted-foreground">{s.essid}</td>
                    <td className="px-3 py-2.5 hidden md:table-cell text-muted-foreground">{fmtBytes(s.bytes)}</td>
                    <td className="px-3 py-2.5 hidden md:table-cell text-muted-foreground">
                      {s.duration_minutes < 60
                        ? `${s.duration_minutes}m`
                        : `${Math.floor(s.duration_minutes / 60)}h ${s.duration_minutes % 60}m`}
                    </td>
                    <td className="px-3 py-2.5 hidden lg:table-cell text-xs text-muted-foreground">
                      {formatDate(s.start)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{s.voucher_code || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Devices Tab ──────────────────────────────────────────────────────────────

function DevicesTab({ locationId }: { locationId: string }) {
  const [devices, setDevices] = useState<KnownDevice[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ location_id: locationId });
      if (query) params.set("search", query);
      const res = await fetch(`/api/unifi/known-devices?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setDevices(json.data ?? []);
      setTotal(json.total ?? 0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load devices");
    } finally {
      setLoading(false);
    }
  }, [locationId, query]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Input
          placeholder="Search MAC or hostname…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setQuery(search); }}
          className="max-w-xs"
        />
        <Button variant="outline" size="sm" onClick={() => setQuery(search)}>Search</Button>
        {query && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setQuery(""); }}>Clear</Button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{total} devices</span>
      </div>

      {loading ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2.5 text-left font-medium">MAC</th>
                <th className="px-3 py-2.5 text-left font-medium">Hostname</th>
                <th className="px-3 py-2.5 text-left font-medium hidden md:table-cell">Note</th>
                <th className="px-3 py-2.5 text-left font-medium">Type</th>
                <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">First Seen</th>
                <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No devices found
                  </td>
                </tr>
              ) : devices.map((d, i) => (
                <tr key={i} className="border-b hover:bg-muted/30 transition-colors">
                  <td className="px-3 py-2.5 font-mono text-xs">{d.mac}</td>
                  <td className="px-3 py-2.5">{d.hostname || "—"}</td>
                  <td className="px-3 py-2.5 hidden md:table-cell text-muted-foreground">{d.note || "—"}</td>
                  <td className="px-3 py-2.5">
                    <Badge variant="secondary" className={d.is_guest ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-800"}>
                      {d.is_guest ? "Guest" : "Staff"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 hidden lg:table-cell text-xs text-muted-foreground">{formatDate(d.first_seen)}</td>
                  <td className="px-3 py-2.5 hidden lg:table-cell text-xs text-muted-foreground">{formatDate(d.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Infrastructure Tab ───────────────────────────────────────────────────────

function InfrastructureTab({ locationId, isInfraRole }: { locationId: string; isInfraRole: boolean }) {
  const [aps, setAps] = useState<AccessPoint[]>([]);
  const [netConfig, setNetConfig] = useState<NetworkConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const requests: Promise<Response>[] = [
        fetch(`/api/unifi/access-points?location_id=${locationId}`),
      ];
      if (isInfraRole) {
        requests.push(fetch(`/api/unifi/network-config?location_id=${locationId}`));
      }
      const responses = await Promise.all(requests);
      const [apsJson, configJson] = await Promise.all(responses.map((r) => r.json()));

      if (!responses[0].ok) throw new Error(apsJson.error || "Failed to load APs");
      setAps(apsJson.data ?? []);

      if (isInfraRole && configJson) {
        setNetConfig(configJson);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load infrastructure");
    } finally {
      setLoading(false);
    }
  }, [locationId, isInfraRole]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>;

  return (
    <div className="space-y-6">
      {/* Access Points */}
      <div>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Signal className="h-4 w-4" /> Access Points ({aps.length})
        </h2>
        {aps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No access points found.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {aps.map((ap) => {
              const isUp = ap.status === "connected";
              return (
                <Card key={ap._id}>
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex h-2 w-2 rounded-full ${isUp ? "bg-green-500" : "bg-red-500"}`} />
                        <span className="font-semibold text-sm">{ap.name}</span>
                      </div>
                      <Badge variant="outline" className="text-xs">{ap.model}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>IP: <span className="font-mono">{ap.ip}</span></p>
                      <p>Uptime: {ap.uptime_human}</p>
                      <p>Clients: <strong className="text-foreground">{ap.clients}</strong></p>
                      <p>Satisfaction: <strong className={`${(ap.satisfaction ?? 0) >= 75 ? "text-green-600" : (ap.satisfaction ?? 0) >= 50 ? "text-amber-600" : "text-red-600"}`}>{ap.satisfaction ?? "—"}{ap.satisfaction != null ? "%" : ""}</strong></p>
                    </div>
                    <div className="flex gap-2 text-xs text-muted-foreground">
                      <span>↑ {fmtBytes(ap.tx_bytes)}</span>
                      <span>↓ {fmtBytes(ap.rx_bytes)}</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Network config — infra roles only */}
      {isInfraRole && netConfig && (
        <>
          {/* WLANs */}
          <div>
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Wifi className="h-4 w-4" /> Wireless Networks ({netConfig.wlans.length})
            </h2>
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2.5 text-left font-medium">SSID</th>
                    <th className="px-3 py-2.5 text-left font-medium">Security</th>
                    <th className="px-3 py-2.5 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {netConfig.wlans.map((w) => (
                    <tr key={w.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2.5 font-medium">{w.name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{w.security}</td>
                      <td className="px-3 py-2.5">
                        <Badge variant="secondary" className={w.enabled ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground"}>
                          {w.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Port Forwards */}
          {netConfig.port_forwards.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Server className="h-4 w-4" /> Port Forwards ({netConfig.port_forwards.length})
              </h2>
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2.5 text-left font-medium">Name</th>
                      <th className="px-3 py-2.5 text-left font-medium">Protocol</th>
                      <th className="px-3 py-2.5 text-left font-medium">Src Port</th>
                      <th className="px-3 py-2.5 text-left font-medium">Dst IP:Port</th>
                    </tr>
                  </thead>
                  <tbody>
                    {netConfig.port_forwards.map((pf) => (
                      <tr key={pf.id} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2.5">{pf.name}</td>
                        <td className="px-3 py-2.5 text-muted-foreground uppercase text-xs">{pf.proto}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{pf.src_port}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{pf.dst_ip}:{pf.dst_port}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Configuration Tab (admin-only) ──────────────────────────────────────────

function ConfigurationTab({
  locationId,
  location,
  onSaved,
}: {
  locationId: string;
  location: Location | null;
  onSaved: (updated: Partial<Location> & { id: string }) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    wifi_voucher_mode: location?.wifi_voucher_mode ?? "repository",
    unifi_site_id: location?.unifi_site_id ?? "",
    unifi_console_id: location?.unifi_console_id ?? "",
  });

  // Sync form when location changes (selector switch)
  useEffect(() => {
    setForm({
      wifi_voucher_mode: location?.wifi_voucher_mode ?? "repository",
      unifi_site_id: location?.unifi_site_id ?? "",
      unifi_console_id: location?.unifi_console_id ?? "",
    });
  }, [locationId, location]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/locations/${locationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wifi_voucher_mode: form.wifi_voucher_mode || null,
          unifi_site_id: form.unifi_site_id.trim() || null,
          unifi_console_id: form.unifi_console_id.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast.success("Location configuration saved");
      onSaved({
        id: locationId,
        wifi_voucher_mode: form.wifi_voucher_mode || null,
        unifi_site_id: form.unifi_site_id.trim() || null,
        unifi_console_id: form.unifi_console_id.trim() || null,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const isUnifi = form.wifi_voucher_mode === "unifi_api";

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Settings2 className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-base font-semibold">WiFi Voucher Configuration</h2>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-5">
          {/* Voucher mode */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Voucher Mode</label>
            <Select
              value={form.wifi_voucher_mode ?? "repository"}
              onValueChange={(v) => setForm((f) => ({ ...f, wifi_voucher_mode: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="repository">Repository (pre-uploaded pool)</SelectItem>
                <SelectItem value="unifi_api">UniFi Live API (on-demand generation)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {isUnifi
                ? "Vouchers are generated in real-time via the UniFi controller API. Each seat gets its own code valid for the contract duration."
                : "Vouchers are issued from a pre-uploaded pool. Upload codes in advance via the Vouchers section."}
            </p>
          </div>

          {/* UniFi Site ID */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              UniFi Site ID
              {isUnifi && <span className="text-red-500 ml-1">*</span>}
            </label>
            <Input
              value={form.unifi_site_id}
              onChange={(e) => setForm((f) => ({ ...f, unifi_site_id: e.target.value }))}
              placeholder="e.g. default"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              The site slug used in the UniFi API path:{" "}
              <code className="bg-muted px-1 rounded text-[11px]">
                /api/s/&#123;site_id&#125;
              </code>
            </p>
          </div>

          {/* UniFi Console ID */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">UniFi Console ID (UUID)</label>
            <Input
              value={form.unifi_console_id}
              onChange={(e) => setForm((f) => ({ ...f, unifi_console_id: e.target.value }))}
              placeholder="e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Cloud console UUID from the UniFi API URL. Leave blank to use the{" "}
              <code className="bg-muted px-1 rounded text-[11px]">UNIFI_CONSOLE_ID</code> env var.
            </p>
          </div>

          {isUnifi && !form.unifi_site_id.trim() && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              UniFi Site ID is required when using the Live API mode. Voucher issuance will fail without it.
            </div>
          )}

          <div className="pt-2">
            <Button onClick={handleSave} disabled={saving} className="gap-2">
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : "Save Configuration"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Status summary */}
      <div className="rounded-md border px-4 py-3 text-sm space-y-1">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Current Status</p>
        <div className="flex items-center gap-2 pt-1">
          <span className={`inline-flex h-2 w-2 rounded-full ${isUnifi ? "bg-green-500" : "bg-slate-300"}`} />
          <span>
            {isUnifi ? "Live API mode active" : "Repository mode active"}
          </span>
        </div>
        {form.unifi_site_id && (
          <p className="text-xs text-muted-foreground">
            Site: <code className="bg-muted px-1 rounded">{form.unifi_site_id}</code>
          </p>
        )}
        {form.unifi_console_id && (
          <p className="text-xs text-muted-foreground">
            Console: <code className="bg-muted px-1 rounded text-[10px]">{form.unifi_console_id}</code>
          </p>
        )}
      </div>
    </div>
  );
}

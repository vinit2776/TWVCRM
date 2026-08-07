"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import {
  Wifi, RefreshCw, Server, Users, Activity, MonitorSmartphone,
  Signal, Globe, ChevronLeft, ChevronRight, Settings2, Save,
  RotateCcw, Zap, X, Laptop, Bell, Ban, ShieldCheck, LogOut,
  AlertTriangle, CheckCircle2, Info, UserCheck,
} from "lucide-react";
import { VoucherCustomerGroups } from "@/components/vouchers/voucher-customer-groups";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { toast } from "sonner";
import { formatDate, formatDateTime } from "@/lib/utils";
import dynamic from "next/dynamic";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

const VisitorsChart = dynamic(
  () => import("@/components/network/network-charts").then((m) => ({ default: m.VisitorsChart })),
  { ssr: false }
);
const BandwidthChart = dynamic(
  () => import("@/components/network/network-charts").then((m) => ({ default: m.BandwidthChart })),
  { ssr: false }
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtUptime(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function signalBar(signal: number): string {
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
    latency: number | null;
    uptime: number | null;
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
  _id: string; mac: string | null; name: string; ip: string; model: string; status: string;
  uptime_human: string; clients: number; tx_bytes: number; rx_bytes: number;
  satisfaction: number; cpu_pct: number | null; mem_pct: number | null;
}

interface GuestSession {
  _id: string; mac: string; hostname: string; essid: string; ip: string;
  bytes: number; duration_minutes: number; start: string; voucher_code: string;
}

interface KnownDevice {
  mac: string; hostname: string | null; name: string | null; note: string;
  is_guest: boolean; blocked: boolean; last_seen: string | null; oui: string | null;
}

interface DeviceLabel {
  id: string;
  mac: string;
  label: string;
  contract_id: string | null;
  contracts: { contract_number: string; title: string } | null;
}

interface NetworkEvent {
  id: string;
  key: string;
  msg: string;
  time: string;
  subsystem: string | null;
  device: string | null;
  device_mac: string | null;
  client_mac: string | null;
  is_negative: boolean;
  archived?: boolean;
  type: "event" | "alarm";
}

interface NetworkConfig {
  port_forwards: { id: string; name: string; proto: string; src_port: number; dst_port: number; dst_ip: string; }[];
  wlans: { id: string; name: string; security: string; enabled: boolean; }[];
}

interface LiveStatus {
  connected: boolean;
  hostname?: string | null;
  ip?: string | null;
  essid?: string | null;
  ap_mac?: string | null;
  signal?: number | null;
  uptime_seconds?: number | null;
  rx_bytes?: number | null;
  tx_bytes?: number | null;
  is_guest?: boolean;
  assoc_time?: string | null;
}

interface DeviceSession {
  start: string;
  duration_seconds: number;
  rx_bytes: number;
  tx_bytes: number;
  essid: string | null;
  ap_mac: string | null;
  is_guest: boolean;
}

// ─── Tab definitions ──────────────────────────────────────────────────────────

type Tab = "overview" | "visitors" | "bandwidth" | "sessions" | "devices" | "infrastructure" | "events" | "customers" | "configuration";

const CUSTOMER_GROUP_ROLES = ["admin", "manager", "it_manager", "it_technician"];

const TABS: { id: Tab; label: string; icon: React.ElementType; adminOnly?: boolean; roles?: string[] }[] = [
  { id: "overview",        label: "Overview",        icon: Activity },
  { id: "visitors",        label: "Visitors",        icon: Users },
  { id: "bandwidth",       label: "Bandwidth",       icon: Globe },
  { id: "sessions",        label: "Sessions",        icon: Wifi },
  { id: "devices",         label: "Devices",         icon: MonitorSmartphone },
  { id: "infrastructure",  label: "Infrastructure",  icon: Server },
  { id: "events",          label: "Events",          icon: Bell },
  { id: "customers",       label: "Customers",       icon: UserCheck, roles: CUSTOMER_GROUP_ROLES },
  { id: "configuration",   label: "Configuration",   icon: Settings2, adminOnly: true },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NetworkPage() {
  const { user } = useCurrentUser();
  const userRole = user?.role ?? null;
  const [tab, setTab] = useState<Tab>("overview");
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>("");

  useEffect(() => {
    fetch("/api/locations").then((r) => r.json()).then((locJson) => {
      const allLocs: Location[] = locJson.data ?? locJson ?? [];
      setLocations(allLocs);
      const firstUnifi = allLocs.find((l) => l.unifi_site_id);
      if (firstUnifi) setLocationId(firstUnifi.id);
      else if (allLocs.length > 0) setLocationId(allLocs[0].id);
    }).catch(() => {});
  }, []);

  const isInfraRole = userRole
    ? ["admin", "it_manager", "it_technician"].includes(userRole)
    : false;
  const isAdmin = userRole === "admin";
  const canRunCommands = userRole ? ["admin", "it_manager"].includes(userRole) : false;
  const canManageLabels = userRole ? ["admin", "manager", "sales_rep"].includes(userRole) : false;

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
      <PageBreadcrumb resetTo={{ label: "Network" }} />
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
        {TABS.filter((t) => (!t.adminOnly || isAdmin) && (!t.roles || (userRole && t.roles.includes(userRole)))).map((t) => (
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
              {tab === "visitors"       && <VisitorsTab locationId={locationId} canRunCommands={canRunCommands} />}
              {tab === "bandwidth"      && <BandwidthTab locationId={locationId} />}
              {tab === "sessions"       && <SessionsTab locationId={locationId} />}
              {tab === "devices"        && <DevicesTab locationId={locationId} canRunCommands={canRunCommands} canManageLabels={canManageLabels} />}
              {tab === "infrastructure" && (
                <InfrastructureTab
                  locationId={locationId}
                  isInfraRole={isInfraRole}
                  canRunCommands={canRunCommands}
                />
              )}
              {tab === "events"         && <EventsTab locationId={locationId} />}
              {tab === "customers"      && <VoucherCustomerGroups locationId={locationId} />}
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

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Devices Today</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{data.today.unique_devices}</p>
            <p className="text-xs text-muted-foreground mt-1">Unique devices seen</p>
          </CardContent>
        </Card>

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

function VisitorsTab({ locationId, canRunCommands }: { locationId: string; canRunCommands: boolean }) {
  const [stats, setStats] = useState<StatsPoint[]>([]);
  const [clients, setClients] = useState<OccupancyClient[]>([]);
  const [occStats, setOccStats] = useState<{ total: number; guest: number; staff: number } | null>(null);
  const [aps, setAps] = useState<AccessPoint[]>([]);
  const [apFilter, setApFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [kicking, setKicking] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, occRes, apRes] = await Promise.all([
        fetch(`/api/unifi/stats?location_id=${locationId}&range=hourly&days=1`),
        fetch(`/api/unifi/occupancy?location_id=${locationId}`),
        fetch(`/api/unifi/access-points?location_id=${locationId}`),
      ]);
      const [statsJson, occJson] = await Promise.all([statsRes.json(), occRes.json()]);
      if (!statsRes.ok) throw new Error(statsJson.error || "Failed to load stats");
      if (!occRes.ok) throw new Error(occJson.error || "Failed to load occupancy");
      setStats(statsJson.data ?? []);
      setClients(occJson.data ?? []);
      setOccStats(occJson.stats ?? null);
      setSelected(new Set());
      // AP list is used only for the filter dropdown — some roles that can view
      // Visitors (sales_rep, office_admin) can't call access-points, so fail quietly.
      if (apRes.ok) {
        const apJson = await apRes.json();
        setAps(apJson.data ?? []);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  const visibleClients = apFilter === "all" ? clients : clients.filter((c) => c.ap_mac === apFilter);

  function toggleSelect(mac: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mac)) next.delete(mac); else next.add(mac);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === visibleClients.length ? new Set() : new Set(visibleClients.map((c) => c.mac))
    );
  }

  function selectAllGuests() {
    setSelected(new Set(visibleClients.filter((c) => c.is_guest).map((c) => c.mac)));
  }

  async function kickClient(mac: string) {
    setKicking(mac);
    try {
      const res = await fetch("/api/unifi/clients/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac, cmd: "kick-sta", location_id: locationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success("Client disconnected");
      setClients((prev) => prev.filter((c) => c.mac !== mac));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to kick client");
    } finally {
      setKicking(null);
    }
  }

  async function bulkAction(cmd: "kick-sta" | "block-sta") {
    if (selected.size === 0) return;
    setBulkRunning(true);
    try {
      const res = await fetch("/api/unifi/clients/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macs: Array.from(selected), cmd, location_id: locationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      const failed = (json.results ?? []).filter((r: { ok: boolean }) => !r.ok).length;
      if (failed > 0) {
        toast.error(`${failed} of ${selected.size} failed`);
      } else {
        toast.success(cmd === "kick-sta" ? `Kicked ${selected.size} clients` : `Blocked ${selected.size} clients`);
      }
      if (cmd === "kick-sta") {
        setClients((prev) => prev.filter((c) => !selected.has(c.mac)));
      }
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk action failed");
    } finally {
      setBulkRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Unique Visitors — Last 24h</CardTitle>
        </CardHeader>
        <CardContent>
          <VisitorsChart stats={stats} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold flex items-center justify-between flex-wrap gap-2">
            <span>Live Clients</span>
            <div className="flex items-center gap-3">
              {occStats && (
                <span className="text-xs font-normal text-muted-foreground">
                  {occStats.total} total · {occStats.staff} staff · {occStats.guest} guest
                </span>
              )}
              {aps.length > 0 && (
                <Select value={apFilter} onValueChange={setApFilter}>
                  <SelectTrigger className="h-7 w-[160px] text-xs font-normal"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All APs</SelectItem>
                    {aps.filter((ap) => ap.mac).map((ap) => (
                      <SelectItem key={ap._id} value={ap.mac!}>{ap.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        {canRunCommands && visibleClients.length > 0 && (
          <div className="px-6 pb-2 flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={selectAllGuests}>
              Select all guests
            </Button>
            {selected.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground">{selected.size} selected</span>
                <Button
                  variant="outline" size="sm"
                  className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 gap-1"
                  disabled={bulkRunning}
                  onClick={() => bulkAction("kick-sta")}
                >
                  <LogOut className="h-3 w-3" /> Kick selected
                </Button>
                <Button
                  variant="outline" size="sm"
                  className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 gap-1"
                  disabled={bulkRunning}
                  onClick={() => bulkAction("block-sta")}
                >
                  <Ban className="h-3 w-3" /> Block selected
                </Button>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </>
            )}
          </div>
        )}
        <CardContent className="p-0">
          {visibleClients.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">No clients connected</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {canRunCommands && (
                      <th className="px-4 py-2.5 text-left font-medium w-8">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={selected.size > 0 && selected.size === visibleClients.length}
                          onChange={toggleSelectAll}
                        />
                      </th>
                    )}
                    <th className="px-4 py-2.5 text-left font-medium">MAC</th>
                    <th className="px-4 py-2.5 text-left font-medium">Hostname</th>
                    <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">SSID</th>
                    <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Signal</th>
                    <th className="px-4 py-2.5 text-left font-medium hidden lg:table-cell">Uptime</th>
                    <th className="px-4 py-2.5 text-left font-medium">Type</th>
                    {canRunCommands && <th className="px-4 py-2.5 text-left font-medium"></th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleClients.map((c, i) => (
                    <tr key={i} className="border-b hover:bg-muted/30 transition-colors">
                      {canRunCommands && (
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            className="rounded"
                            checked={selected.has(c.mac)}
                            onChange={() => toggleSelect(c.mac)}
                          />
                        </td>
                      )}
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
                      {canRunCommands && (
                        <td className="px-4 py-2.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 gap-1"
                            disabled={kicking === c.mac}
                            onClick={() => kickClient(c.mac)}
                          >
                            <LogOut className="h-3 w-3" />
                            {kicking === c.mac ? "…" : "Kick"}
                          </Button>
                        </td>
                      )}
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
          <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="hourly">Hourly</SelectItem>
            <SelectItem value="daily">Daily</SelectItem>
          </SelectContent>
        </Select>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
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
            <BandwidthChart stats={stats} />
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
              <p className="text-xs text-muted-foreground">Page {page} of {totalPages}</p>
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

// ─── Device Activity Sheet ────────────────────────────────────────────────────

function DeviceActivitySheet({
  device,
  locationId,
  canRunCommands,
  canManageLabels,
  label,
  onClose,
  onBlockToggle,
  onLabelSaved,
}: {
  device: KnownDevice | null;
  locationId: string;
  canRunCommands: boolean;
  canManageLabels: boolean;
  label: DeviceLabel | null;
  onClose: () => void;
  onBlockToggle: (mac: string, blocked: boolean) => void;
  onLabelSaved: () => void;
}) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [blocking, setBlocking] = useState(false);

  useEffect(() => {
    if (!device) return;
    setLoading(true);
    setLive(null);
    setSessions([]);
    fetch(`/api/unifi/device-activity?mac=${encodeURIComponent(device.mac)}&location_id=${locationId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) throw new Error(json.error);
        setLive(json.live ?? null);
        setSessions(json.sessions ?? []);
      })
      .catch((err) => toast.error(err.message || "Failed to load device activity"))
      .finally(() => setLoading(false));
  }, [device, locationId]);

  async function toggleBlock() {
    if (!device) return;
    const cmd = device.blocked ? "unblock-sta" : "block-sta";
    setBlocking(true);
    try {
      const res = await fetch("/api/unifi/clients/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac: device.mac, cmd, location_id: locationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      const nowBlocked = cmd === "block-sta";
      toast.success(nowBlocked ? "Device blocked" : "Device unblocked");
      onBlockToggle(device.mac, nowBlocked);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Command failed");
    } finally {
      setBlocking(false);
    }
  }

  const displayName = device?.hostname || device?.name || device?.mac || "Device";

  return (
    <Sheet open={Boolean(device)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="flex items-center gap-2">
            <Laptop className="h-5 w-5 text-muted-foreground" />
            {displayName}
            {device?.blocked && (
              <Badge variant="secondary" className="bg-red-100 text-red-700 text-xs ml-1">Blocked</Badge>
            )}
          </SheetTitle>
          <div className="flex items-center justify-between">
            {device && (
              <p className="text-xs font-mono text-muted-foreground">{device.mac}</p>
            )}
            {canRunCommands && device && (
              <Button
                variant="outline"
                size="sm"
                className={`gap-1.5 text-xs h-7 ${device.blocked ? "text-green-700 border-green-300 hover:bg-green-50" : "text-red-600 border-red-300 hover:bg-red-50"}`}
                disabled={blocking}
                onClick={toggleBlock}
              >
                {device.blocked
                  ? <><ShieldCheck className="h-3 w-3" />{blocking ? "…" : "Unblock"}</>
                  : <><Ban className="h-3 w-3" />{blocking ? "…" : "Block"}</>
                }
              </Button>
            )}
          </div>
        </SheetHeader>

        {device && (canManageLabels || label) && (
          <DeviceLabelEditor
            key={device.mac}
            mac={device.mac}
            locationId={locationId}
            label={label}
            editable={canManageLabels}
            onSaved={onLabelSaved}
          />
        )}

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-48" />
          </div>
        )}

        {!loading && live && (
          <div className="space-y-6">
            {/* Live status */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Current Status
              </h3>
              {live.connected ? (
                <div className="rounded-lg border bg-green-50 border-green-200 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-2 w-2 rounded-full bg-green-500" />
                    <span className="font-semibold text-sm text-green-800">Connected</span>
                    {live.is_guest && (
                      <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-xs ml-auto">Guest</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {live.essid && (
                      <><span className="text-muted-foreground">SSID</span><span className="font-medium">{live.essid}</span></>
                    )}
                    {live.ip && (
                      <><span className="text-muted-foreground">IP</span><span className="font-mono">{live.ip}</span></>
                    )}
                    {live.signal != null && (
                      <><span className="text-muted-foreground">Signal</span><span className="font-mono">{signalBar(live.signal)} {live.signal} dBm</span></>
                    )}
                    {live.uptime_seconds != null && (
                      <><span className="text-muted-foreground">Session uptime</span><span>{fmtUptime(live.uptime_seconds)}</span></>
                    )}
                    {(live.rx_bytes != null || live.tx_bytes != null) && (
                      <><span className="text-muted-foreground">Data this session</span><span>↑ {fmtBytes(live.tx_bytes)} · ↓ {fmtBytes(live.rx_bytes)}</span></>
                    )}
                    {live.ap_mac && (
                      <><span className="text-muted-foreground">AP</span><span className="font-mono text-[11px]">{live.ap_mac}</span></>
                    )}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/30 p-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="inline-flex h-2 w-2 rounded-full bg-slate-300" />
                  Not currently connected
                  {device?.last_seen && (
                    <span className="ml-auto text-xs">Last seen {formatDate(device.last_seen)}</span>
                  )}
                </div>
              )}
            </div>

            {/* Session history */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Session History — Last 30 Days
              </h3>
              {sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No sessions found</p>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Started</th>
                        <th className="px-3 py-2 text-left font-medium">Duration</th>
                        <th className="px-3 py-2 text-left font-medium">Data</th>
                        <th className="px-3 py-2 text-left font-medium hidden sm:table-cell">SSID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s, i) => (
                        <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="px-3 py-2 text-muted-foreground">{formatDateTime(s.start)}</td>
                          <td className="px-3 py-2">{fmtDuration(s.duration_seconds)}</td>
                          <td className="px-3 py-2">{fmtBytes(s.rx_bytes + s.tx_bytes)}</td>
                          <td className="px-3 py-2 hidden sm:table-cell text-muted-foreground">{s.essid ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Device Label Editor ───────────────────────────────────────────────────────

interface ContractSearchResult {
  id: string;
  contract_number: string;
  title: string;
}

function DeviceLabelEditor({
  mac,
  locationId,
  label,
  editable,
  onSaved,
}: {
  mac: string;
  locationId: string;
  label: DeviceLabel | null;
  editable: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(label?.label ?? "");
  const [contractQuery, setContractQuery] = useState("");
  const [contractResults, setContractResults] = useState<ContractSearchResult[]>([]);
  const [selectedContract, setSelectedContract] = useState<ContractSearchResult | null>(
    label?.contract_id && label.contracts
      ? { id: label.contract_id, contract_number: label.contracts.contract_number, title: label.contracts.title }
      : null
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing || contractQuery.trim().length < 2) { setContractResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contracts?search=${encodeURIComponent(contractQuery)}&location_id=${locationId}&limit=8`);
        const json = await res.json();
        if (res.ok) setContractResults(json.data ?? []);
      } catch {
        // ignore — search is best-effort
      }
    }, 300);
    return () => clearTimeout(t);
  }, [contractQuery, editing, locationId]);

  async function save() {
    if (!text.trim()) { toast.error("Label cannot be empty"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/unifi/device-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: locationId,
          mac,
          label: text.trim(),
          contract_id: selectedContract?.id ?? null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save label");
      toast.success("Label saved");
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save label");
    } finally {
      setSaving(false);
    }
  }

  if (!editable && !label) return null;

  if (!editing) {
    return (
      <div className="mb-4 rounded-md border bg-muted/20 px-3 py-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          {label ? (
            <>
              <p className="text-sm font-medium truncate">{label.label}</p>
              {label.contracts && (
                <p className="text-xs text-muted-foreground truncate">
                  Linked to {label.contracts.contract_number} — {label.contracts.title}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No label set</p>
          )}
        </div>
        {editable && (
          <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={() => setEditing(true)}>
            {label ? "Edit" : "Add label"}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-md border bg-muted/20 p-3 space-y-2">
      <Input
        placeholder="e.g. John's laptop"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="h-8 text-sm"
      />
      <div className="relative">
        <Input
          placeholder="Search contract to link (optional)…"
          value={selectedContract ? `${selectedContract.contract_number} — ${selectedContract.title}` : contractQuery}
          onChange={(e) => { setSelectedContract(null); setContractQuery(e.target.value); }}
          className="h-8 text-sm"
        />
        {contractResults.length > 0 && !selectedContract && (
          <div className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow-md max-h-48 overflow-y-auto">
            {contractResults.map((c) => (
              <button
                key={c.id}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50"
                onClick={() => { setSelectedContract(c); setContractResults([]); }}
              >
                <span className="font-medium">{c.contract_number}</span> — {c.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
        <Button size="sm" className="h-7 text-xs" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}

// ─── Devices Tab ──────────────────────────────────────────────────────────────

function DevicesTab({ locationId, canRunCommands, canManageLabels }: { locationId: string; canRunCommands: boolean; canManageLabels: boolean }) {
  const [devices, setDevices] = useState<KnownDevice[]>([]);
  const [labels, setLabels] = useState<Record<string, DeviceLabel>>({});
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedDevice, setSelectedDevice] = useState<KnownDevice | null>(null);

  const loadLabels = useCallback(async () => {
    try {
      const res = await fetch(`/api/unifi/device-labels?location_id=${locationId}`);
      const json = await res.json();
      if (!res.ok) return;
      const map: Record<string, DeviceLabel> = {};
      for (const l of (json.data ?? []) as DeviceLabel[]) map[l.mac] = l;
      setLabels(map);
    } catch {
      // labels are a non-critical enhancement — fail silently
    }
  }, [locationId]);

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
  useEffect(() => { loadLabels(); }, [loadLabels]);

  return (
    <>
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
                  <th className="px-3 py-2.5 text-left font-medium hidden md:table-cell">Vendor</th>
                  <th className="px-3 py-2.5 text-left font-medium">Type</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Last Seen</th>
                  <th className="px-3 py-2.5 text-left font-medium"></th>
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
                  <tr
                    key={i}
                    className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => setSelectedDevice(d)}
                  >
                    <td className="px-3 py-2.5 font-mono text-xs">{d.mac}</td>
                    <td className="px-3 py-2.5">
                      {labels[d.mac] ? (
                        <div>
                          <span className="font-medium">{labels[d.mac].label}</span>
                          {labels[d.mac].contracts && (
                            <span className="block text-xs text-muted-foreground">{labels[d.mac].contracts!.contract_number}</span>
                          )}
                        </div>
                      ) : (
                        d.hostname || d.name || "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 hidden md:table-cell text-muted-foreground text-xs">{d.oui || "—"}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className={d.is_guest ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-800"}>
                          {d.is_guest ? "Guest" : "Staff"}
                        </Badge>
                        {d.blocked && (
                          <Badge variant="secondary" className="bg-red-100 text-red-700 text-xs">Blocked</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 hidden lg:table-cell text-xs text-muted-foreground">
                      {d.last_seen ? formatDate(d.last_seen) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className="text-xs text-primary hover:underline">View activity →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DeviceActivitySheet
        device={selectedDevice}
        locationId={locationId}
        canRunCommands={canRunCommands}
        canManageLabels={canManageLabels}
        label={selectedDevice ? labels[selectedDevice.mac] ?? null : null}
        onClose={() => setSelectedDevice(null)}
        onBlockToggle={(mac, blocked) => {
          setDevices((prev) => prev.map((d) => d.mac === mac ? { ...d, blocked } : d));
          setSelectedDevice((prev) => prev?.mac === mac ? { ...prev, blocked } : prev);
        }}
        onLabelSaved={loadLabels}
      />
    </>
  );
}

// ─── AP Command Confirm Dialog ────────────────────────────────────────────────

type ApCmd = "force-provision" | "restart";

interface ApCommandState {
  ap: AccessPoint;
  cmd: ApCmd;
}

const CMD_LABELS: Record<ApCmd, { label: string; description: string; icon: React.ElementType }> = {
  "force-provision": {
    label: "Reprovision",
    description: "Forces the AP to re-apply its full configuration from the controller. The AP briefly goes offline during provisioning.",
    icon: Zap,
  },
  "restart": {
    label: "Restart",
    description: "Reboots the AP. All clients will be disconnected for 30–60 seconds while the AP comes back online.",
    icon: RotateCcw,
  },
};

function ApCommandDialog({
  state,
  locationId,
  onClose,
}: {
  state: ApCommandState | null;
  locationId: string;
  onClose: () => void;
}) {
  const [running, setRunning] = useState(false);

  async function execute() {
    if (!state) return;
    setRunning(true);
    try {
      const res = await fetch("/api/unifi/access-points/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac: state.ap.mac, cmd: state.cmd, location_id: locationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Command failed");
      toast.success(`${CMD_LABELS[state.cmd].label} sent to ${state.ap.name}`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Command failed");
    } finally {
      setRunning(false);
    }
  }

  if (!state) return null;
  const meta = CMD_LABELS[state.cmd];
  const Icon = meta.icon;

  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => { if (!open && !running) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-amber-500" />
            {meta.label} — {state.ap.name}
          </DialogTitle>
          <DialogDescription className="pt-1">
            {meta.description}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-muted px-4 py-3 text-xs space-y-1">
          <p><span className="text-muted-foreground">AP:</span> <strong>{state.ap.name}</strong></p>
          {state.ap.mac && <p><span className="text-muted-foreground">MAC:</span> <span className="font-mono">{state.ap.mac}</span></p>}
          <p><span className="text-muted-foreground">IP:</span> <span className="font-mono">{state.ap.ip ?? "—"}</span></p>
          <p><span className="text-muted-foreground">Clients connected:</span> <strong>{state.ap.clients}</strong></p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={running}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={execute}
            disabled={running || !state.ap.mac}
          >
            {running ? "Sending…" : `Confirm ${meta.label}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Events Tab ──────────────────────────────────────────────────────────────

const EVENT_KEY_LABELS: Record<string, string> = {
  EVT_AP_Connected:        "AP Connected",
  EVT_AP_Disconnected:     "AP Disconnected",
  EVT_AP_RestartedUnknown: "AP Restarted",
  EVT_AP_Upgraded:         "AP Upgraded",
  EVT_GW_WAN_Transition:   "WAN Transition",
  EVT_GW_Failover:         "WAN Failover",
  EVT_SW_Connected:        "Switch Connected",
  EVT_SW_Disconnected:     "Switch Disconnected",
  EVT_LU_Connected:        "Client Connected",
  EVT_LU_Disconnected:     "Client Disconnected",
  EVT_LG_Connected:        "Guest Connected",
  EVT_LG_Disconnected:     "Guest Disconnected",
  EVT_AD_LoginSuccess:     "Admin Login",
  EVT_AD_LoginFailed:      "Admin Login Failed",
};

function eventLabel(key: string): string {
  return EVENT_KEY_LABELS[key] ?? key.replace(/^EVT_[A-Z]+_/, "").replace(/_/g, " ");
}

function EventsTab({ locationId }: { locationId: string }) {
  const [events, setEvents] = useState<NetworkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAlarms, setShowAlarms] = useState(true);
  const [subsystem, setSubsystem] = useState<string>("all");
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setUnavailable(null);
    try {
      const params = new URLSearchParams({
        location_id: locationId,
        limit: "200",
        include_alarms: showAlarms ? "true" : "false",
      });
      const res = await fetch(`/api/unifi/events?${params}`);
      const json = await res.json();
      if (!res.ok) {
        // Some consoles don't expose event/alarm history via the proxy API —
        // show this inline rather than as a transient-looking error toast.
        setUnavailable(json.error || "Event/alarm history is not available for this console.");
        setEvents([]);
        return;
      }
      setEvents(json.data ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [locationId, showAlarms]);

  useEffect(() => { load(); }, [load]);

  const subsystems = ["all", ...Array.from(new Set(events.map((e) => e.subsystem).filter(Boolean)))];
  const filtered = subsystem === "all" ? events : events.filter((e) => e.subsystem === subsystem);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={subsystem} onValueChange={setSubsystem}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {subsystems.map((s) => (
              <SelectItem key={s} value={s!}>{s === "all" ? "All subsystems" : s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showAlarms}
            onChange={(e) => setShowAlarms(e.target.checked)}
            className="rounded"
          />
          Include active alarms
        </label>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="ml-auto">
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : unavailable ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground gap-2 text-center px-6">
          <AlertTriangle className="h-8 w-8 opacity-30" />
          <p className="text-sm">{unavailable}</p>
          <p className="text-xs">This UniFi console doesn&apos;t expose event/alarm history through the cloud proxy API.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground gap-2">
          <Bell className="h-8 w-8 opacity-30" />
          <p className="text-sm">No events found</p>
        </div>
      ) : (
        <div className="rounded-md border divide-y overflow-hidden">
          {filtered.map((e) => {
            const isAlarm = e.type === "alarm";
            const Icon = isAlarm
              ? AlertTriangle
              : e.is_negative
                ? AlertTriangle
                : e.key.toLowerCase().includes("connect") && !e.key.toLowerCase().includes("disconnect")
                  ? CheckCircle2
                  : Info;
            const iconColor = isAlarm
              ? "text-red-500"
              : e.is_negative
                ? "text-amber-500"
                : e.key.toLowerCase().includes("connect") && !e.key.toLowerCase().includes("disconnect")
                  ? "text-green-500"
                  : "text-blue-400";

            return (
              <div
                key={e.id}
                className={`flex items-start gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors ${isAlarm ? "bg-red-50/50" : ""}`}
              >
                <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${iconColor}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{eventLabel(e.key)}</span>
                    {isAlarm && (
                      <Badge variant="secondary" className="bg-red-100 text-red-700 text-xs">Alarm</Badge>
                    )}
                    {e.subsystem && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">{e.subsystem}</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs mt-0.5 truncate">{e.msg}</p>
                  {e.device && (
                    <p className="text-xs text-muted-foreground mt-0.5">Device: <span className="font-medium text-foreground">{e.device}</span></p>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                  {formatDateTime(e.time)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Infrastructure Tab ───────────────────────────────────────────────────────

function InfrastructureTab({
  locationId,
  isInfraRole,
  canRunCommands,
}: {
  locationId: string;
  isInfraRole: boolean;
  canRunCommands: boolean;
}) {
  const [aps, setAps] = useState<AccessPoint[]>([]);
  const [netConfig, setNetConfig] = useState<NetworkConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [cmdState, setCmdState] = useState<ApCommandState | null>(null);

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
      if (isInfraRole && configJson) setNetConfig(configJson);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load infrastructure");
    } finally {
      setLoading(false);
    }
  }, [locationId, isInfraRole]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>;

  return (
    <>
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
                const isUp = ap.status === "online";
                return (
                  <Card key={ap._id}>
                    <CardContent className="pt-4 space-y-3">
                      {/* Header row */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex h-2 w-2 rounded-full ${isUp ? "bg-green-500" : "bg-red-500"}`} />
                          <span className="font-semibold text-sm">{ap.name}</span>
                        </div>
                        <Badge variant="outline" className="text-xs">{ap.model}</Badge>
                      </div>

                      {/* Stats */}
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        <p>IP: <span className="font-mono">{ap.ip}</span></p>
                        <p>Uptime: {ap.uptime_human}</p>
                        <p>Clients: <strong className="text-foreground">{ap.clients}</strong></p>
                        {ap.cpu_pct != null && (
                          <p>CPU / RAM: <strong className="text-foreground">{ap.cpu_pct.toFixed(0)}%</strong>{ap.mem_pct != null && ` / ${ap.mem_pct.toFixed(0)}%`}</p>
                        )}
                        <p>
                          Satisfaction:{" "}
                          <strong className={
                            (ap.satisfaction ?? 0) >= 75 ? "text-green-600" :
                            (ap.satisfaction ?? 0) >= 50 ? "text-amber-600" : "text-red-600"
                          }>
                            {ap.satisfaction ?? "—"}{ap.satisfaction != null ? "%" : ""}
                          </strong>
                        </p>
                      </div>

                      <div className="flex gap-2 text-xs text-muted-foreground">
                        <span>↑ {fmtBytes(ap.tx_bytes)}</span>
                        <span>↓ {fmtBytes(ap.rx_bytes)}</span>
                      </div>

                      {/* Command buttons — admin / it_manager only, AP must have a MAC */}
                      {canRunCommands && ap.mac && (
                        <div className="flex gap-2 pt-1 border-t">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-xs gap-1"
                            onClick={() => setCmdState({ ap, cmd: "force-provision" })}
                          >
                            <Zap className="h-3 w-3" /> Reprovision
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-xs gap-1"
                            onClick={() => setCmdState({ ap, cmd: "restart" })}
                          >
                            <RotateCcw className="h-3 w-3" /> Restart
                          </Button>
                        </div>
                      )}
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

      <ApCommandDialog
        state={cmdState}
        locationId={locationId}
        onClose={() => setCmdState(null)}
      />
    </>
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
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Voucher Mode</label>
            <Select
              value={form.wifi_voucher_mode ?? "repository"}
              onValueChange={(v) => setForm((f) => ({ ...f, wifi_voucher_mode: v }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
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
              <code className="bg-muted px-1 rounded text-[11px]">/api/s/&#123;site_id&#125;</code>
            </p>
          </div>

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

      <div className="rounded-md border px-4 py-3 text-sm space-y-1">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Current Status</p>
        <div className="flex items-center gap-2 pt-1">
          <span className={`inline-flex h-2 w-2 rounded-full ${isUnifi ? "bg-green-500" : "bg-slate-300"}`} />
          <span>{isUnifi ? "Live API mode active" : "Repository mode active"}</span>
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

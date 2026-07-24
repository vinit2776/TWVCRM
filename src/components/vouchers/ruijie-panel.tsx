"use client";

/**
 * RuijiePanel — read-only network + voucher monitoring for Ruijie-managed
 * locations (currently Nungambakkam Arcade).
 *
 * Voucher issuance for Ruijie locations happens through the normal contract
 * flow (ContractVouchersSection), same as repository mode — this panel is
 * for visibility only: device health, voucher status, connected clients.
 *
 * Sections (top → bottom):
 *  1. Device status cards — online/offline, client count, CPU/memory, firmware
 *  2. Voucher stats + table — masked codes, matches ContractVouchersSection data
 *  3. Connected clients — signal quality, throughput, session duration
 */

import { useState, useEffect, useCallback } from "react";
import {
  Wifi, RefreshCw, CheckCircle2, XCircle, Activity, Cpu, HardDrive,
  Users, AlertTriangle, Signal, ArrowDown, ArrowUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { EmptyState } from "@/components/shared/empty-state";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RuijieDevice {
  serialNumber: string;
  productClass: string;
  commonType: string;
  onlineStatus: string;
  name: string;
  aliasName: string;
  softwareVersion: string;
  newestSoftwareVersion: string;
  staNums: number;
  staActiveNums: number;
  radio1ChannelUtil?: number;
  radio2ChannelUtil?: number;
  performance: { cpuRate: number; memoryRate: number; flashRate: number } | null;
}

interface RuijieVoucher {
  uuid: string;
  code: string;
  packageName: string;
  status: string;
  timePeriodMinutes: number;
  maxClients: number;
  currentClients: number;
  usedQuota: number;
  createTime: number;
  expiryTime: number | null;
  comment: string;
}

interface RuijieClient {
  mac: string;
  ssid: string;
  band: string;
  userIp: string;
  rssiInt: number;
  score: number;
  scoreReason: string;
  onlineTime: number;
  wifiUp: number;
  wifiDown: number;
  deviceAliasName: string;
}

interface VoucherStats { total: number; unused: number; inUse: number; expired: number; }

interface RuijiePanelProps {
  locationId: string;
  locationName: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VOUCHER_STATUS_LABEL: Record<string, string> = { "1": "Unused", "2": "In use", "3": "Expired" };
const VOUCHER_STATUS_COLOR: Record<string, string> = {
  "1": "bg-blue-100 text-blue-800",
  "2": "bg-green-100 text-green-800",
  "3": "bg-red-100 text-red-800",
};

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fmtMinutes(mins: number): string {
  const days = Math.round(mins / 1440);
  if (days >= 1) return `${days}d`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h`;
}

function fmtDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" });
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function scoreColor(score: number): string {
  if (score >= 70) return "bg-green-100 text-green-800";
  if (score >= 40) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RuijiePanel({ locationId, locationName }: RuijiePanelProps) {
  const [devices, setDevices] = useState<RuijieDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const [vouchers, setVouchers] = useState<RuijieVoucher[]>([]);
  const [voucherStats, setVoucherStats] = useState<VoucherStats | null>(null);
  const [vouchersLoading, setVouchersLoading] = useState(true);
  const [vouchersError, setVouchersError] = useState<string | null>(null);

  const [clients, setClients] = useState<RuijieClient[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true); setDevicesError(null);
    try {
      const res = await fetch(`/api/ruijie/devices?location_id=${locationId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load devices");
      setDevices(json.data || []);
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDevicesLoading(false);
    }
  }, [locationId]);

  const fetchVouchers = useCallback(async () => {
    setVouchersLoading(true); setVouchersError(null);
    try {
      const res = await fetch(`/api/ruijie/vouchers?location_id=${locationId}&per_page=50`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load vouchers");
      setVouchers(json.data || []);
      setVoucherStats(json.stats || null);
    } catch (err) {
      setVouchersError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setVouchersLoading(false);
    }
  }, [locationId]);

  const fetchClients = useCallback(async () => {
    setClientsLoading(true); setClientsError(null);
    try {
      const res = await fetch(`/api/ruijie/clients?location_id=${locationId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load clients");
      setClients(json.data || []);
    } catch (err) {
      setClientsError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setClientsLoading(false);
    }
  }, [locationId]);

  const refreshAll = useCallback(() => {
    fetchDevices(); fetchVouchers(); fetchClients();
  }, [fetchDevices, fetchVouchers, fetchClients]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  return (
    <div className="space-y-6">
      {/* ── Header bar ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Wifi className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Live — {locationName}</span>
          <Badge variant="outline" className="text-xs font-mono">Ruijie Cloud API</Badge>
        </div>
        <Button
          variant="outline" size="sm" onClick={refreshAll}
          disabled={devicesLoading || vouchersLoading || clientsLoading}
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${devicesLoading || vouchersLoading || clientsLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* ── Section 1: Device status ── */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Devices</h3>
        {devicesError ? (
          <ErrorBanner message={devicesError} />
        ) : devicesLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[140px]" />)}
          </div>
        ) : devices.length === 0 ? (
          <EmptyState icon={Wifi} title="No devices found" description="No AP, gateway, or switch registered under this location's Ruijie group." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {devices.map((d) => <DeviceCard key={d.serialNumber} device={d} />)}
          </div>
        )}
      </section>

      {/* ── Section 2: Vouchers ── */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Vouchers</h3>
        {vouchersError ? (
          <ErrorBanner message={vouchersError} />
        ) : (
          <>
            {voucherStats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard icon={Activity}     label="Total"   value={voucherStats.total}   color="text-foreground" />
                <StatCard icon={CheckCircle2} label="In use"  value={voucherStats.inUse}   color="text-green-600" />
                <StatCard icon={Signal}       label="Unused"  value={voucherStats.unused}  color="text-blue-600" />
                <StatCard icon={XCircle}      label="Expired" value={voucherStats.expired} color="text-red-500" />
              </div>
            )}
            {vouchersLoading ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : vouchers.length === 0 ? (
              <EmptyState icon={Wifi} title="No vouchers found" description="No vouchers exist for this location yet." />
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2.5 text-left font-medium">Code</th>
                      <th className="px-3 py-2.5 text-left font-medium">Package</th>
                      <th className="px-3 py-2.5 text-left font-medium">Status</th>
                      <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">Comment</th>
                      <th className="px-3 py-2.5 text-left font-medium hidden md:table-cell">Devices</th>
                      <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Data used</th>
                      <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vouchers.map((v) => (
                      <tr key={v.uuid} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2.5 font-mono text-xs font-semibold tracking-wider">{v.code}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">{v.packageName} ({fmtMinutes(v.timePeriodMinutes)})</td>
                        <td className="px-3 py-2.5">
                          <Badge variant="secondary" className={`text-xs ${VOUCHER_STATUS_COLOR[v.status] || "bg-muted"}`}>
                            {VOUCHER_STATUS_LABEL[v.status] || v.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell max-w-[180px] truncate">{v.comment || "—"}</td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell text-center">{v.currentClients}/{v.maxClients}</td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell">{fmtBytes(v.usedQuota * 1024 * 1024)}</td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell text-xs">{fmtDate(v.expiryTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Section 3: Connected clients ── */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Connected Clients</h3>
        {clientsError ? (
          <ErrorBanner message={clientsError} />
        ) : clientsLoading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : clients.length === 0 ? (
          <EmptyState icon={Users} title="No clients connected" description="No devices are currently online on this network." />
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2.5 text-left font-medium">Device</th>
                  <th className="px-3 py-2.5 text-left font-medium">Signal</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">SSID / Band</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden md:table-cell">AP</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Traffic</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Connected</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.mac} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs">{c.mac} <span className="text-muted-foreground">({c.userIp})</span></td>
                    <td className="px-3 py-2.5">
                      <Badge variant="secondary" className={`text-xs ${scoreColor(c.score)}`}>
                        {c.score} · {c.rssiInt} dBm
                      </Badge>
                      {c.score < 40 && <p className="text-[10px] text-red-600 mt-0.5">{c.scoreReason}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">{c.ssid} · {c.band}</td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell">{c.deviceAliasName}</td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell text-xs">
                      <span className="inline-flex items-center gap-0.5"><ArrowDown className="h-3 w-3" />{fmtBytes(c.wifiDown)}</span>{" "}
                      <span className="inline-flex items-center gap-0.5"><ArrowUp className="h-3 w-3" />{fmtBytes(c.wifiUp)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell text-xs">{timeAgo(c.onlineTime)} ago</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DeviceCard({ device }: { device: RuijieDevice }) {
  const online = device.onlineStatus === "ON";
  const updateAvailable = device.newestSoftwareVersion && device.softwareVersion !== device.newestSoftwareVersion;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`} />
          <span className="font-medium text-sm">{device.aliasName || device.name || device.serialNumber}</span>
        </div>
        <Badge variant="outline" className="text-[10px]">{device.productClass}</Badge>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{device.staActiveNums}/{device.staNums} active</span>
        {updateAvailable && (
          <span className="flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3.5 w-3.5" />Update available</span>
        )}
      </div>

      {device.performance && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center gap-1.5">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
            <span>CPU {device.performance.cpuRate}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Mem {device.performance.memoryRate}%</span>
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground font-mono">{device.serialNumber}</p>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType; label: string; value: number; color: string;
}) {
  return (
    <div className="rounded-lg border p-3 space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 ${color}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0" />{message}
    </div>
  );
}

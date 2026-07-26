"use client";

/**
 * RuijiePanel — network + voucher monitoring for Ruijie-managed locations
 * (currently Nungambakkam Arcade), plus ad-hoc voucher issuance for walk-in
 * guests (from a small allowlist of IT's existing generic packages — never
 * the tenant-specific ones, never a custom duration).
 *
 * Contract-driven voucher issuance for Ruijie locations happens through the
 * normal contract flow (ContractVouchersSection), same as repository mode.
 *
 * Sections (top → bottom):
 *  1. Pending ad-hoc requests queue — visible to admin/manager only
 *  2. Device status cards — online/offline, client count, CPU/memory, firmware
 *  3. Voucher stats + table — masked codes, matches ContractVouchersSection data
 *  4. Connected clients — signal quality, throughput, session duration
 *  5. Issue Ad-hoc dialog — direct (admin/manager) or approval-gated (others)
 */

import { useState, useEffect, useCallback } from "react";
import {
  Wifi, RefreshCw, CheckCircle2, XCircle, Activity, Cpu, HardDrive,
  Users, AlertTriangle, Signal, ArrowDown, ArrowUp, Plus, Clock,
  ChevronDown, ChevronUp, Copy, Check, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { toast } from "sonner";

const ADHOC_ALLOWED_PACKAGES = ["daypass"] as const;

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

interface PendingRequest {
  id: string;
  reason: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
  requester?: { full_name: string; email: string; role: string } | null;
}

interface RuijiePanelProps {
  locationId: string;
  locationName: string;
  userRole: string;
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

function timeAgoIso(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function scoreColor(score: number): string {
  if (score >= 70) return "bg-green-100 text-green-800";
  if (score >= 40) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RuijiePanel({ locationId, locationName, userRole }: RuijiePanelProps) {
  const canApprove = ["admin", "manager"].includes(userRole);
  const canIssueDirect = canApprove;

  // Pending requests queue state (admin/manager only)
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [queueOpen, setQueueOpen] = useState(true);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [issuedVouchers, setIssuedVouchers] = useState<Record<string, { code: string; packageUsed: string }>>({});
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);

  // Issue dialog state
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueLoading, setIssueLoading] = useState(false);
  const [issuePackage, setIssuePackage] = useState<string>(ADHOC_ALLOWED_PACKAGES[0]);
  const [issueNote, setIssueNote] = useState("");
  const [issueReason, setIssueReason] = useState("");
  const [directIssued, setDirectIssued] = useState<{ code: string; packageUsed: string } | null>(null);

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

  const fetchPendingRequests = useCallback(async () => {
    if (!canApprove) return;
    try {
      const res = await fetch(`/api/ruijie/requests?location_id=${locationId}&status=pending`);
      if (res.ok) {
        const json = await res.json();
        setPendingRequests(json.data || []);
      }
    } catch { /* silent */ }
  }, [locationId, canApprove]);

  useEffect(() => {
    fetchPendingRequests();
    const interval = setInterval(fetchPendingRequests, 30_000);
    return () => clearInterval(interval);
  }, [fetchPendingRequests]);

  async function handleQueueAction(id: string, action: "approve" | "reject") {
    setActingOnId(id);
    try {
      const body: Record<string, string> = { action };
      if (action === "reject") {
        if (!rejectionReason.trim()) { toast.error("Reason required"); setActingOnId(null); return; }
        body.rejection_reason = rejectionReason.trim();
      }
      const res = await fetch(`/api/approval-requests/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to ${action}`);

      toast.success(json.message || `Request ${action}d`);

      if (action === "approve" && json.ruijie_voucher) {
        setIssuedVouchers(prev => ({ ...prev, [id]: { code: json.ruijie_voucher.code, packageUsed: json.ruijie_voucher.packageUsed } }));
        setPendingRequests(prev => prev.filter(r => r.id !== id));
        fetchVouchers();
      } else {
        setPendingRequests(prev => prev.filter(r => r.id !== id));
      }
      setRejectingId(null); setRejectionReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
    setActingOnId(null);
  }

  function copyShareMsg(id: string, voucher: { code: string; packageUsed: string }) {
    navigator.clipboard.writeText(`WiFi voucher for ${locationName}: ${voucher.code} (${voucher.packageUsed})`);
    setCopiedShareId(id);
    toast.success("Message copied");
    setTimeout(() => setCopiedShareId(null), 2000);
  }

  function resetIssueForm() {
    setIssuePackage(ADHOC_ALLOWED_PACKAGES[0]); setIssueNote(""); setIssueReason(""); setDirectIssued(null);
  }

  async function handleIssue() {
    if (!issueNote.trim()) { toast.error("Note / label is required"); return; }
    if (!canIssueDirect && !issueReason.trim()) { toast.error("Reason is required for approval request"); return; }

    setIssueLoading(true);
    try {
      const res = await fetch("/api/ruijie/vouchers/adhoc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: locationId, package_name: issuePackage,
          note: issueNote.trim(), reason: issueReason.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok && res.status !== 202) throw new Error(json.error || "Failed");

      if (json.issued) {
        setDirectIssued({ code: json.code, packageUsed: json.package_used });
        fetchVouchers();
      } else {
        toast.success("Request submitted for approval");
        setIssueOpen(false);
        resetIssueForm();
        fetchPendingRequests();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to issue voucher");
    } finally {
      setIssueLoading(false);
    }
  }

  const pendingCount = pendingRequests.length;

  return (
    <div className="space-y-6">
      {/* ── Pending Requests Queue (admin/manager only) ── */}
      {canApprove && (pendingCount > 0 || Object.keys(issuedVouchers).length > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-amber-50 transition-colors"
            onClick={() => setQueueOpen(v => !v)}
          >
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-600" />
              <span className="text-sm font-semibold text-amber-800">Pending Voucher Requests</span>
              {pendingCount > 0 && (
                <Badge className="bg-amber-600 text-white text-[10px] px-1.5 py-0 h-4">{pendingCount}</Badge>
              )}
            </div>
            {queueOpen ? <ChevronUp className="h-4 w-4 text-amber-600" /> : <ChevronDown className="h-4 w-4 text-amber-600" />}
          </button>

          {queueOpen && (
            <div className="divide-y divide-amber-100 border-t border-amber-200">
              {Object.entries(issuedVouchers).map(([reqId, voucher]) => (
                <div key={reqId} className="px-4 py-3 bg-green-50 space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                    <span className="text-sm font-medium text-green-800">Voucher Issued</span>
                  </div>
                  <div className="text-center py-1">
                    <p className="font-mono text-lg font-bold tracking-widest">{voucher.code}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{voucher.packageUsed}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button className="flex-1 h-7 text-xs" variant="outline" onClick={() => copyShareMsg(reqId, voucher)}>
                      {copiedShareId === reqId
                        ? <><Check className="h-3 w-3 mr-1 text-green-600" />Copied!</>
                        : <><Copy className="h-3 w-3 mr-1" />Copy message</>}
                    </Button>
                    <Button variant="ghost" className="h-7 text-xs"
                      onClick={() => setIssuedVouchers(prev => { const n = { ...prev }; delete n[reqId]; return n; })}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              ))}

              {pendingRequests.map((req) => {
                const meta = req.metadata || {};
                const isRej = rejectingId === req.id;
                return (
                  <div key={req.id} className="px-4 py-3 space-y-2">
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>
                        <span className="font-medium text-foreground">{req.requester?.full_name || "Unknown"}</span>
                        {" "}· {timeAgoIso(req.created_at)}
                      </p>
                      <p>Package: <strong className="text-foreground">{String(meta.package_name ?? "—")}</strong></p>
                      {meta.note != null && <p>Note: <span className="text-foreground">{String(meta.note)}</span></p>}
                      {req.reason && <p className="italic text-amber-700">&ldquo;{req.reason}&rdquo;</p>}
                    </div>

                    {isRej && (
                      <Input autoFocus value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)}
                        placeholder="Reason for rejection..." className="h-7 text-xs" />
                    )}

                    <div className="flex gap-2">
                      <Button size="sm" className="flex-1 h-7 text-xs bg-green-600 hover:bg-green-700"
                        disabled={actingOnId === req.id} onClick={() => handleQueueAction(req.id, "approve")}>
                        {actingOnId === req.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
                        Approve &amp; Issue
                      </Button>
                      {isRej ? (
                        <Button size="sm" variant="destructive" className="flex-1 h-7 text-xs"
                          disabled={actingOnId === req.id || !rejectionReason.trim()} onClick={() => handleQueueAction(req.id, "reject")}>
                          {actingOnId === req.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                          Confirm Reject
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="flex-1 h-7 text-xs text-destructive hover:text-destructive"
                          onClick={() => { setRejectingId(req.id); setRejectionReason(""); }}>
                          <XCircle className="h-3 w-3 mr-1" />Reject
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Header bar ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Wifi className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Live — {locationName}</span>
          <Badge variant="outline" className="text-xs font-mono">Ruijie Cloud API</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm" onClick={refreshAll}
            disabled={devicesLoading || vouchersLoading || clientsLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${devicesLoading || vouchersLoading || clientsLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => { resetIssueForm(); setIssueOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />Issue Ad-hoc
          </Button>
        </div>
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

      {/* ── Issue Ad-hoc Dialog ── */}
      <Dialog open={issueOpen} onOpenChange={(v) => { setIssueOpen(v); if (!v) resetIssueForm(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wifi className="h-5 w-5 text-primary" />
              {directIssued ? "Voucher Issued" : "Issue Ad-hoc WiFi Voucher"}
            </DialogTitle>
          </DialogHeader>

          {directIssued ? (
            <div className="space-y-4 py-2">
              <div className="text-center py-2">
                <p className="text-xs text-muted-foreground mb-1">Voucher Code</p>
                <p className="font-mono text-xl font-bold tracking-widest">{directIssued.code}</p>
                <p className="text-xs text-muted-foreground mt-1">{directIssued.packageUsed}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  className="flex-1" variant="outline"
                  onClick={() => copyShareMsg("direct", directIssued)}
                >
                  {copiedShareId === "direct"
                    ? <><Check className="h-4 w-4 mr-1.5 text-green-600" />Copied!</>
                    : <><Copy className="h-4 w-4 mr-1.5" />Copy message</>}
                </Button>
                <Button variant="ghost" onClick={() => { setIssueOpen(false); resetIssueForm(); }}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {!canIssueDirect && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>Requires manager or admin approval before the voucher is issued. Your request will be queued for review.</span>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>Package</Label>
                <Select value={issuePackage} onValueChange={setIssuePackage}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ADHOC_ALLOWED_PACKAGES.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Only IT&apos;s existing generic packages can be used — never a tenant-specific one, never a custom duration.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Note / Label</Label>
                <Input placeholder="e.g. Guest day pass, Meeting room visitor"
                  value={issueNote} onChange={(e) => setIssueNote(e.target.value)} maxLength={200} />
                <p className="text-xs text-muted-foreground">Stored on the voucher&apos;s comment field for traceability.</p>
              </div>

              {!canIssueDirect && (
                <div className="space-y-1.5">
                  <Label>Reason <span className="text-destructive">*</span></Label>
                  <Textarea placeholder="Why is this voucher needed? Who is it for?"
                    value={issueReason} onChange={(e) => setIssueReason(e.target.value)} rows={3} maxLength={500} />
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => { setIssueOpen(false); resetIssueForm(); }}>Cancel</Button>
                <Button onClick={handleIssue} disabled={issueLoading}>
                  {issueLoading ? "Processing…" : canIssueDirect ? "Issue Voucher" : "Submit for Approval"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
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

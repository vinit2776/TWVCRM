"use client";

/**
 * UnifiPanel — live voucher management for UniFi-managed locations.
 *
 * Sections (top → bottom):
 *  1. Pending Requests queue  — visible to admin/manager only; approve/reject inline
 *  2. Stats bar               — total / valid / used / expired from device
 *  3. Live voucher table      — real-time data from the UniFi device
 *  4. Issue Ad-hoc dialog     — direct (admin/manager) or approval-gated (others)
 */

import { useState, useEffect, useCallback } from "react";
import {
  Wifi, RefreshCw, Plus, CheckCircle2, Clock, XCircle, Activity,
  ChevronLeft, ChevronRight, AlertTriangle, Copy, Check, Loader2,
  ChevronDown, ChevronUp,
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
import {
  buildShareableMessage, fmtDuration, type ShareableVoucher,
} from "@/lib/unifi-share";
import { VoucherCustomerGroups } from "@/components/vouchers/voucher-customer-groups";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UnifiVoucher {
  _id: string; code: string; note: string; duration: number;
  quota: number; used: number; status: string; create_time: number;
  start_time?: number; end_time?: number;
  qos_rate_max_down?: number; qos_rate_max_up?: number;
}

interface Stats { total: number; valid: number; used: number; expired: number; }

interface Pagination { page: number; per_page: number; total: number; total_pages: number; }

interface PendingRequest {
  id: string;
  reason: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
  requester?: { full_name: string; email: string; role: string } | null;
}

interface UnifiPanelProps {
  locationId: string;
  locationName: string;
  userRole: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  VALID_ONE: "bg-green-100 text-green-800", VALID_MULTI: "bg-emerald-100 text-emerald-800",
  USED_ONE: "bg-blue-100 text-blue-800",   USED_MULTIPLE: "bg-blue-100 text-blue-800",
  EXPIRED: "bg-red-100 text-red-800",
};
const STATUS_LABEL: Record<string, string> = {
  VALID_ONE: "Valid (1-use)", VALID_MULTI: "Valid (multi)",
  USED_ONE: "Used",          USED_MULTIPLE: "Partially used",
  EXPIRED: "Expired",
};

const DURATION_PRESETS = [
  { label: "2 hours",  minutes: 120 },  { label: "4 hours",  minutes: 240 },
  { label: "8 hours",  minutes: 480 },  { label: "1 day",    minutes: 1440 },
  { label: "3 days",   minutes: 4320 }, { label: "7 days",   minutes: 10080 },
  { label: "30 days",  minutes: 43200 },{ label: "Custom",   minutes: 0 },
];

const PAGE_SIZE = 20;

function fmtUnixDate(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" });
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function UnifiPanel({ locationId, locationName, userRole }: UnifiPanelProps) {
  // Voucher list state
  const [vouchers, setVouchers] = useState<UnifiVoucher[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revealedCodes, setRevealedCodes] = useState<Record<string, string>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);

  // Pending requests queue state (admin/manager only)
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [queueOpen, setQueueOpen] = useState(true);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  // After approval — hold voucher details for shareable message
  const [issuedVouchers, setIssuedVouchers] = useState<Record<string, ShareableVoucher>>({});
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);

  // Issue dialog state
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueLoading, setIssueLoading] = useState(false);
  const [durationPreset, setDurationPreset] = useState("480");
  const [customMinutes, setCustomMinutes] = useState("");
  const [issueNote, setIssueNote] = useState("");
  const [issueQuota, setIssueQuota] = useState("1");
  const [issueReason, setIssueReason] = useState("");
  const [issueContract, setIssueContract] = useState<{ id: string; contract_number: string; title: string } | null>(null);
  const [issueContractQuery, setIssueContractQuery] = useState("");
  const [issueContractResults, setIssueContractResults] = useState<{ id: string; contract_number: string; title: string }[]>([]);
  // After direct issuance (admin/manager) — show code + shareable message in dialog
  const [directIssued, setDirectIssued] = useState<ShareableVoucher | null>(null);
  const [ssid, setSsid] = useState<string | null>(null);

  const canApprove = ["admin", "manager"].includes(userRole);
  const canIssueDirect = canApprove;
  const canViewCustomerGroups = ["admin", "manager", "it_manager", "it_technician"].includes(userRole);

  // Fetch SSID once
  useEffect(() => {
    fetch("/api/unifi/wlan")
      .then(r => r.json())
      .then(d => { if (d.ssid) setSsid(d.ssid); })
      .catch(() => {});
  }, []);

  // Contract search for the optional "Link to contract" field on Issue Ad-hoc
  useEffect(() => {
    if (issueContractQuery.trim().length < 2) { setIssueContractResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contracts?search=${encodeURIComponent(issueContractQuery)}&location_id=${locationId}&limit=8`);
        const json = await res.json();
        if (res.ok) setIssueContractResults(json.data ?? []);
      } catch {
        // ignore — search is best-effort
      }
    }, 300);
    return () => clearTimeout(t);
  }, [issueContractQuery, locationId]);

  const fetchVouchers = useCallback(async (targetPage = 1) => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({
        location_id: locationId,
        page: String(targetPage),
        per_page: String(PAGE_SIZE),
      });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/unifi/vouchers?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load vouchers");
      setVouchers(json.data || []);
      setStats(json.stats || null);
      setPagination(json.pagination || null);
      setPage(targetPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [locationId, statusFilter]);

  const fetchPendingRequests = useCallback(async () => {
    if (!canApprove) return;
    try {
      const res = await fetch(`/api/unifi/requests?location_id=${locationId}&status=pending`);
      if (res.ok) {
        const json = await res.json();
        setPendingRequests(json.data || []);
      }
    } catch { /* silent */ }
  }, [locationId, canApprove]);

  useEffect(() => {
    fetchVouchers(1);
    fetchPendingRequests();
    // Poll pending queue every 30 s
    const interval = setInterval(fetchPendingRequests, 30_000);
    return () => clearInterval(interval);
  }, [fetchVouchers, fetchPendingRequests]);

  // Vouchers are already paginated server-side; render them directly
  const paginated = vouchers;
  const totalPages = pagination?.total_pages ?? 1;

  // ── Approve / Reject queue actions ────────────────────────────────────────

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

      if (action === "approve" && json.voucher) {
        setIssuedVouchers(prev => ({ ...prev, [id]: json.voucher as ShareableVoucher }));
        // Keep in list to show the code; remove from pending count
        setPendingRequests(prev => prev.filter(r => r.id !== id));
        fetchVouchers(1); // refresh live table
      } else {
        setPendingRequests(prev => prev.filter(r => r.id !== id));
      }
      setRejectingId(null); setRejectionReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
    setActingOnId(null);
  }

  function copyShareMsg(id: string, voucher: ShareableVoucher) {
    navigator.clipboard.writeText(buildShareableMessage(voucher));
    setCopiedShareId(id);
    toast.success("Shareable message copied");
    setTimeout(() => setCopiedShareId(null), 2000);
  }

  // ── Issue ad-hoc ──────────────────────────────────────────────────────────

  async function handleIssue() {
    const minutes = durationPreset === "0" ? parseInt(customMinutes) : parseInt(durationPreset);
    if (!minutes || minutes < 1) { toast.error("Enter a valid duration"); return; }
    if (!issueNote.trim()) { toast.error("Note / label is required"); return; }
    if (!canIssueDirect && !issueReason.trim()) { toast.error("Reason is required for approval request"); return; }

    setIssueLoading(true);
    try {
      const res = await fetch("/api/unifi/vouchers/adhoc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: locationId, duration_minutes: minutes,
          note: issueNote.trim(), quota: parseInt(issueQuota) || 1,
          reason: issueReason.trim() || undefined,
          contract_id: issueContract?.id,
        }),
      });
      const json = await res.json();
      if (!res.ok && res.status !== 202) throw new Error(json.error || "Failed");

      if (json.issued) {
        const voucher: ShareableVoucher = {
          code: json.code, ssid, durationMinutes: minutes,
          quota: parseInt(issueQuota) || 1, locationName,
        };
        setDirectIssued(voucher);
        fetchVouchers(1);
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

  function resetIssueForm() {
    setDurationPreset("480"); setCustomMinutes(""); setIssueNote("");
    setIssueQuota("1"); setIssueReason(""); setDirectIssued(null);
    setIssueContract(null); setIssueContractQuery(""); setIssueContractResults([]);
  }

  async function handleReveal(voucherId: string) {
    if (revealedCodes[voucherId]) return;
    setRevealingId(voucherId);
    try {
      const res = await fetch("/api/unifi/vouchers/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucher_id: voucherId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to reveal code");
      setRevealedCodes((prev) => ({ ...prev, [voucherId]: json.code }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reveal code");
    } finally {
      setRevealingId(null);
    }
  }

  function copyVoucherCode(code: string, id: string) {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    toast.success("Code copied");
    setTimeout(() => setCopiedId(null), 2000);
  }

  // ─────────────────────────────────────────────────────────────────────────

  const pendingCount = pendingRequests.length;

  return (
    <div className="space-y-4">

      {/* ── Pending Requests Queue (admin/manager only) ── */}
      {canApprove && (pendingCount > 0 || Object.keys(issuedVouchers).length > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-amber-50 transition-colors"
            onClick={() => setQueueOpen(v => !v)}
          >
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-600" />
              <span className="text-sm font-semibold text-amber-800">
                Pending Voucher Requests
              </span>
              {pendingCount > 0 && (
                <Badge className="bg-amber-600 text-white text-[10px] px-1.5 py-0 h-4">
                  {pendingCount}
                </Badge>
              )}
            </div>
            {queueOpen
              ? <ChevronUp className="h-4 w-4 text-amber-600" />
              : <ChevronDown className="h-4 w-4 text-amber-600" />}
          </button>

          {queueOpen && (
            <div className="divide-y divide-amber-100 border-t border-amber-200">
              {/* Already-issued (waiting for copy/dismiss) */}
              {Object.entries(issuedVouchers).map(([reqId, voucher]) => (
                <div key={reqId} className="px-4 py-3 bg-green-50 space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                    <span className="text-sm font-medium text-green-800">Voucher Issued</span>
                  </div>
                  <ShareableBlock
                    voucher={voucher}
                    copied={copiedShareId === reqId}
                    onCopy={() => copyShareMsg(reqId, voucher)}
                    onDismiss={() => {
                      setIssuedVouchers(prev => { const n = { ...prev }; delete n[reqId]; return n; });
                    }}
                  />
                </div>
              ))}

              {/* Pending */}
              {pendingRequests.map((req) => {
                const meta = req.metadata || {};
                const isRej = rejectingId === req.id;
                return (
                  <div key={req.id} className="px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        <p>
                          <span className="font-medium text-foreground">
                            {req.requester?.full_name || "Unknown"}
                          </span>
                          {" "}· {timeAgo(req.created_at)}
                        </p>
                        <p className="flex gap-3">
                          <span>Duration: <strong className="text-foreground">{fmtDuration(Number(meta.duration_minutes ?? 0))}</strong></span>
                          <span>Devices: <strong className="text-foreground">{String(meta.quota ?? 1)}</strong></span>
                        </p>
                        {meta.note != null && (
                          <p>Note: <span className="text-foreground">{String(meta.note)}</span></p>
                        )}
                        {req.reason && (
                          <p className="italic text-amber-700">&ldquo;{req.reason}&rdquo;</p>
                        )}
                      </div>
                    </div>

                    {isRej && (
                      <Input
                        autoFocus value={rejectionReason}
                        onChange={(e) => setRejectionReason(e.target.value)}
                        placeholder="Reason for rejection..."
                        className="h-7 text-xs"
                      />
                    )}

                    <div className="flex gap-2">
                      <Button
                        size="sm" className="flex-1 h-7 text-xs bg-green-600 hover:bg-green-700"
                        disabled={actingOnId === req.id}
                        onClick={() => handleQueueAction(req.id, "approve")}
                      >
                        {actingOnId === req.id
                          ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          : <CheckCircle2 className="h-3 w-3 mr-1" />}
                        Approve &amp; Issue
                      </Button>
                      {isRej ? (
                        <Button
                          size="sm" variant="destructive" className="flex-1 h-7 text-xs"
                          disabled={actingOnId === req.id || !rejectionReason.trim()}
                          onClick={() => handleQueueAction(req.id, "reject")}
                        >
                          {actingOnId === req.id
                            ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            : <XCircle className="h-3 w-3 mr-1" />}
                          Confirm Reject
                        </Button>
                      ) : (
                        <Button
                          size="sm" variant="outline" className="flex-1 h-7 text-xs text-destructive hover:text-destructive"
                          onClick={() => { setRejectingId(req.id); setRejectionReason(""); }}
                        >
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
          <Badge variant="outline" className="text-xs font-mono">UniFi API</Badge>
          {ssid && (
            <Badge variant="secondary" className="text-xs gap-1">
              <Wifi className="h-3 w-3" />{ssid}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter || "__all__"} onValueChange={(v) => setStatusFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="w-[160px] h-8 text-xs"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              <SelectItem value="VALID_ONE">Valid (1-use)</SelectItem>
              <SelectItem value="VALID_MULTI">Valid (multi)</SelectItem>
              <SelectItem value="USED_ONE">Used</SelectItem>
              <SelectItem value="USED_MULTIPLE">Partially used</SelectItem>
              <SelectItem value="EXPIRED">Expired</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => fetchVouchers(1)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
          <Button size="sm" onClick={() => { resetIssueForm(); setIssueOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />Issue Ad-hoc
          </Button>
        </div>
      </div>

      {/* ── Stats bar ── */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={Activity}      label="Total"   value={stats.total}   color="text-foreground" />
          <StatCard icon={CheckCircle2}  label="Active"  value={stats.valid}   color="text-green-600" />
          <StatCard icon={Clock}         label="Used"    value={stats.used}    color="text-blue-600" />
          <StatCard icon={XCircle}       label="Expired" value={stats.expired} color="text-red-500" />
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {/* ── Voucher table ── */}
      {loading ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : !error && vouchers.length === 0 ? (
        <EmptyState
          icon={Wifi} title="No vouchers found"
          description="No vouchers exist on the UniFi device for this location."
          actionLabel="Issue Ad-hoc Voucher"
          onAction={() => { resetIssueForm(); setIssueOpen(true); }}
        />
      ) : !error && (
        <>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2.5 text-left font-medium">Code</th>
                  <th className="px-3 py-2.5 text-left font-medium">Status</th>
                  <th className="px-3 py-2.5 text-left font-medium">Duration</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">Note</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden md:table-cell">Devices</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Created</th>
                  <th className="px-3 py-2.5 text-left font-medium hidden lg:table-cell">Expires</th>
                  <th className="px-3 py-2.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((v) => (
                  <tr key={v._id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold tracking-wider">
                      {revealedCodes[v._id] ?? v.code}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant="secondary" className={`text-xs ${STATUS_COLOR[v.status] || "bg-muted text-muted-foreground"}`}>
                        {STATUS_LABEL[v.status] || v.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{fmtDuration(v.duration)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell max-w-[180px] truncate">{v.note || "—"}</td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell text-center">
                      {v.used}/{v.quota === 0 ? "∞" : v.quota}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell text-xs">{fmtUnixDate(v.create_time)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell text-xs">{fmtUnixDate(v.end_time)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {!revealedCodes[v._id] && (
                          <Button
                            variant="ghost" size="sm" className="h-7 px-2 text-xs"
                            onClick={() => handleReveal(v._id)}
                            disabled={revealingId === v._id}
                            title="Reveal full code"
                          >
                            {revealingId === v._id
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : "Reveal"}
                          </Button>
                        )}
                        {revealedCodes[v._id] && (
                          <span className="text-[10px] text-green-600 font-medium mr-1">Revealed</span>
                        )}
                        <Button
                          variant="ghost" size="sm" className="h-7 w-7 p-0"
                          onClick={() => copyVoucherCode(revealedCodes[v._id] ?? v.code, v._id)}
                          title="Copy voucher code"
                        >
                          {copiedId === v._id
                            ? <Check className="h-3.5 w-3.5 text-green-600" />
                            : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pagination && pagination.total_pages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, pagination.total)} of {pagination.total}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => fetchVouchers(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => fetchVouchers(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Devices by Customer ── */}
      {canViewCustomerGroups && <VoucherCustomerGroups locationId={locationId} />}

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
            /* ── Direct issue success: shareable message ── */
            <div className="space-y-4 py-2">
              <ShareableBlock
                voucher={directIssued}
                copied={copiedShareId === "direct"}
                onCopy={() => { copyShareMsg("direct", directIssued); }}
                onDismiss={() => { setIssueOpen(false); resetIssueForm(); }}
                dismissLabel="Done"
              />
            </div>
          ) : (
            /* ── Issue form ── */
            <div className="space-y-4 py-2">
              {!canIssueDirect && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Requires manager or admin approval before the voucher is issued.
                    Your request will be queued for review.
                  </span>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>Duration</Label>
                <Select value={durationPreset} onValueChange={setDurationPreset}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DURATION_PRESETS.map((p) => (
                      <SelectItem key={p.minutes} value={String(p.minutes)}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {durationPreset === "0" && (
                  <Input type="number" min={1} placeholder="Enter minutes"
                    value={customMinutes} onChange={(e) => setCustomMinutes(e.target.value)} />
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Note / Label</Label>
                <Input placeholder="e.g. Guest day pass, Meeting room visitor"
                  value={issueNote} onChange={(e) => setIssueNote(e.target.value)} maxLength={200} />
                <p className="text-xs text-muted-foreground">Stored on the voucher in UniFi for reference.</p>
              </div>

              <div className="space-y-1.5">
                <Label>Link to contract (optional)</Label>
                <div className="relative">
                  <Input
                    placeholder="Search contract to link…"
                    value={issueContract ? `${issueContract.contract_number} — ${issueContract.title}` : issueContractQuery}
                    onChange={(e) => { setIssueContract(null); setIssueContractQuery(e.target.value); }}
                  />
                  {issueContractResults.length > 0 && !issueContract && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow-md max-h-48 overflow-y-auto">
                      {issueContractResults.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50"
                          onClick={() => { setIssueContract(c); setIssueContractResults([]); }}
                        >
                          <span className="font-medium">{c.contract_number}</span> — {c.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">Lets &quot;Devices by Customer&quot; resolve who this voucher belongs to.</p>
              </div>

              <div className="space-y-1.5">
                <Label>Max simultaneous devices</Label>
                <Select value={issueQuota} onValueChange={setIssueQuota}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[1,2,3,5,10].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n} device{n > 1 ? "s" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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

// ─── ShareableBlock ───────────────────────────────────────────────────────────

function ShareableBlock({
  voucher, copied, onCopy, onDismiss, dismissLabel = "Dismiss",
}: {
  voucher: ShareableVoucher;
  copied: boolean;
  onCopy: () => void;
  onDismiss: () => void;
  dismissLabel?: string;
}) {
  const msg = buildShareableMessage(voucher);
  return (
    <div className="space-y-3">
      {/* Code highlight */}
      <div className="text-center py-2">
        <p className="text-xs text-muted-foreground mb-1">Voucher Code</p>
        <p className="font-mono text-xl font-bold tracking-widest">{voucher.code}</p>
        <p className="text-xs text-muted-foreground mt-1">
          {fmtDuration(voucher.durationMinutes)} · {voucher.quota === 1 ? "1 device" : `${voucher.quota} devices`}
          {voucher.ssid && ` · ${voucher.ssid}`}
        </p>
      </div>

      {/* Shareable message preview */}
      <div className="rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap leading-relaxed max-h-52 overflow-y-auto">
        {msg}
      </div>

      <div className="flex gap-2">
        <Button className="flex-1" variant="outline" onClick={onCopy}>
          {copied
            ? <><Check className="h-4 w-4 mr-1.5 text-green-600" />Copied!</>
            : <><Copy className="h-4 w-4 mr-1.5" />Copy message</>}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>{dismissLabel}</Button>
      </div>
    </div>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

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

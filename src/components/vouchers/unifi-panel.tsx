"use client";

/**
 * UnifiPanel — live voucher management for UniFi-managed locations.
 *
 * Shows:
 *  • Stats bar (total / valid / used / expired)
 *  • Live voucher table sourced directly from the UniFi device
 *  • "Issue Ad-hoc Voucher" dialog (direct for admin/manager; approval flow for others)
 */

import { useState, useEffect, useCallback } from "react";
import {
  Wifi, RefreshCw, Plus, CheckCircle2, Clock, XCircle, Activity,
  ChevronLeft, ChevronRight, AlertTriangle, Copy, Check,
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface UnifiVoucher {
  _id: string;
  code: string;
  note: string;
  duration: number;      // minutes
  quota: number;
  used: number;
  status: string;
  create_time: number;   // unix seconds
  start_time?: number;
  end_time?: number;
  qos_rate_max_down?: number;
  qos_rate_max_up?: number;
}

interface Stats {
  total: number;
  valid: number;
  used: number;
  expired: number;
}

interface UnifiPanelProps {
  locationId: string;
  locationName: string;
  userRole: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hr`;
  return `${Math.round(minutes / 1440)} days`;
}

function fmtUnixDate(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" });
}

const STATUS_COLOR: Record<string, string> = {
  VALID_ONE:      "bg-green-100 text-green-800",
  VALID_MULTI:    "bg-emerald-100 text-emerald-800",
  USED_ONE:       "bg-blue-100 text-blue-800",
  USED_MULTIPLE:  "bg-blue-100 text-blue-800",
  EXPIRED:        "bg-red-100 text-red-800",
};

const STATUS_LABEL: Record<string, string> = {
  VALID_ONE:      "Valid (1-use)",
  VALID_MULTI:    "Valid (multi)",
  USED_ONE:       "Used",
  USED_MULTIPLE:  "Partially used",
  EXPIRED:        "Expired",
};

// Pre-set duration options for the issue dialog
const DURATION_PRESETS = [
  { label: "2 hours",  minutes: 120 },
  { label: "4 hours",  minutes: 240 },
  { label: "8 hours",  minutes: 480 },
  { label: "1 day",    minutes: 1440 },
  { label: "3 days",   minutes: 4320 },
  { label: "7 days",   minutes: 10080 },
  { label: "30 days",  minutes: 43200 },
  { label: "Custom",   minutes: 0 },
];

const PAGE_SIZE = 20;

// ─── Component ────────────────────────────────────────────────────────────────

export function UnifiPanel({ locationId, locationName, userRole }: UnifiPanelProps) {
  const [vouchers, setVouchers] = useState<UnifiVoucher[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Issue dialog state
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueLoading, setIssueLoading] = useState(false);
  const [durationPreset, setDurationPreset] = useState("480");
  const [customMinutes, setCustomMinutes] = useState("");
  const [issueNote, setIssueNote] = useState("");
  const [issueQuota, setIssueQuota] = useState("1");
  const [issueReason, setIssueReason] = useState("");
  // After successful direct issuance — show the code
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  const canIssueDirect = ["admin", "manager"].includes(userRole);

  const fetchVouchers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ location_id: locationId });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/unifi/vouchers?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load vouchers");
      setVouchers(json.data || []);
      setStats(json.stats || null);
      setPage(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [locationId, statusFilter]);

  useEffect(() => { fetchVouchers(); }, [fetchVouchers]);

  // Paginate client-side (all data already fetched from device)
  const paginated = vouchers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.ceil(vouchers.length / PAGE_SIZE);

  async function handleIssue() {
    const minutes = durationPreset === "0"
      ? parseInt(customMinutes)
      : parseInt(durationPreset);

    if (!minutes || minutes < 1) {
      toast.error("Enter a valid duration"); return;
    }
    if (!issueNote.trim()) {
      toast.error("Note / label is required"); return;
    }
    if (!canIssueDirect && !issueReason.trim()) {
      toast.error("Reason is required for approval request"); return;
    }

    setIssueLoading(true);
    try {
      const res = await fetch("/api/unifi/vouchers/adhoc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id:      locationId,
          duration_minutes: minutes,
          note:             issueNote.trim(),
          quota:            parseInt(issueQuota) || 1,
          reason:           issueReason.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok && res.status !== 202) throw new Error(json.error || "Failed");

      if (json.issued) {
        setIssuedCode(json.code);
        toast.success(`Voucher issued: ${json.code}`);
        fetchVouchers();
      } else {
        toast.success("Request submitted for approval");
        setIssueOpen(false);
        resetIssueForm();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to issue voucher");
    } finally {
      setIssueLoading(false);
    }
  }

  function resetIssueForm() {
    setDurationPreset("480");
    setCustomMinutes("");
    setIssueNote("");
    setIssueQuota("1");
    setIssueReason("");
    setIssuedCode(null);
  }

  function copyCode(code: string, id: string) {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    toast.success("Code copied");
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Wifi className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">
            Live — {locationName}
          </span>
          <Badge variant="outline" className="text-xs font-mono">UniFi API</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter || "__all__"}
            onValueChange={(v) => setStatusFilter(v === "__all__" ? "" : v)}
          >
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              <SelectItem value="VALID_ONE">Valid (1-use)</SelectItem>
              <SelectItem value="VALID_MULTI">Valid (multi)</SelectItem>
              <SelectItem value="USED_ONE">Used</SelectItem>
              <SelectItem value="USED_MULTIPLE">Partially used</SelectItem>
              <SelectItem value="EXPIRED">Expired</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchVouchers} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => { resetIssueForm(); setIssueOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            Issue Ad-hoc
          </Button>
        </div>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={Activity} label="Total" value={stats.total} color="text-foreground" />
          <StatCard icon={CheckCircle2} label="Active" value={stats.valid} color="text-green-600" />
          <StatCard icon={Clock} label="Used" value={stats.used} color="text-blue-600" />
          <StatCard icon={XCircle} label="Expired" value={stats.expired} color="text-red-500" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : !error && vouchers.length === 0 ? (
        <EmptyState
          icon={Wifi}
          title="No vouchers found"
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
                  <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">Note / Label</th>
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
                      {v.code}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge
                        variant="secondary"
                        className={`text-xs ${STATUS_COLOR[v.status] || "bg-muted text-muted-foreground"}`}
                      >
                        {STATUS_LABEL[v.status] || v.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{fmtDuration(v.duration)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell max-w-[180px] truncate">
                      {v.note || "—"}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell text-center">
                      {v.used}/{v.quota === 0 ? "∞" : v.quota}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell text-xs">
                      {fmtUnixDate(v.create_time)}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell text-xs">
                      {fmtUnixDate(v.end_time)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => copyCode(v.code, v._id)}
                        title="Copy voucher code"
                      >
                        {copiedId === v._id
                          ? <Check className="h-3.5 w-3.5 text-green-600" />
                          : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, vouchers.length)} of {vouchers.length}
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

      {/* ── Issue Ad-hoc Voucher Dialog ─────────────────────────────────────── */}
      <Dialog open={issueOpen} onOpenChange={(v) => { setIssueOpen(v); if (!v) resetIssueForm(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wifi className="h-5 w-5 text-primary" />
              {issuedCode ? "Voucher Issued" : "Issue Ad-hoc WiFi Voucher"}
            </DialogTitle>
          </DialogHeader>

          {/* ── Success: show issued code ── */}
          {issuedCode ? (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                The voucher has been created on the UniFi device. Share the code below with the customer.
              </p>
              <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                <code className="text-lg font-mono font-bold tracking-widest flex-1 text-center">
                  {issuedCode}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { navigator.clipboard.writeText(issuedCode); toast.success("Copied"); }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <DialogFooter>
                <Button onClick={() => { setIssueOpen(false); resetIssueForm(); }}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            /* ── Issue form ── */
            <div className="space-y-4 py-2">
              {!canIssueDirect && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Your role requires manager or admin approval before the voucher is issued.
                    Fill in the form and your request will be sent for review.
                  </span>
                </div>
              )}

              {/* Duration preset */}
              <div className="space-y-1.5">
                <Label>Duration</Label>
                <Select value={durationPreset} onValueChange={setDurationPreset}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_PRESETS.map((p) => (
                      <SelectItem key={p.minutes} value={String(p.minutes)}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {durationPreset === "0" && (
                  <Input
                    type="number"
                    min={1}
                    placeholder="Enter minutes"
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(e.target.value)}
                  />
                )}
              </div>

              {/* Note */}
              <div className="space-y-1.5">
                <Label>Note / Label</Label>
                <Input
                  placeholder="e.g. Guest day pass, Meeting room visitor"
                  value={issueNote}
                  onChange={(e) => setIssueNote(e.target.value)}
                  maxLength={200}
                />
                <p className="text-xs text-muted-foreground">
                  Stored on the voucher in UniFi — helps identify it later.
                </p>
              </div>

              {/* Quota */}
              <div className="space-y-1.5">
                <Label>Max simultaneous devices</Label>
                <Select value={issueQuota} onValueChange={setIssueQuota}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1,2,3,5,10].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n} device{n > 1 ? "s" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Reason — only required for non-admin/manager */}
              {!canIssueDirect && (
                <div className="space-y-1.5">
                  <Label>
                    Reason <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    placeholder="Why is this voucher needed? Who is it for?"
                    value={issueReason}
                    onChange={(e) => setIssueReason(e.target.value)}
                    rows={3}
                    maxLength={500}
                  />
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => { setIssueOpen(false); resetIssueForm(); }}>
                  Cancel
                </Button>
                <Button onClick={handleIssue} disabled={issueLoading}>
                  {issueLoading
                    ? "Processing…"
                    : canIssueDirect
                      ? "Issue Voucher"
                      : "Submit for Approval"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Stat card helper ─────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  color: string;
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

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2, XCircle, ClipboardCheck, Loader2, RefreshCw,
  Wifi, Copy, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { buildShareableMessage, fmtDuration } from "@/lib/unifi-share";

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface ApprovalRequest {
  id: string;
  approval_type: string;
  entity_type: string;
  entity_id: string;
  entity_reference: string | null;
  requested_by: string;
  requested_at: string;
  created_at: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  status: string;
  acted_by: string | null;
  acted_at: string | null;
  rejection_reason: string | null;
  requester?: { id: string; full_name: string; email: string; role: string } | null;
}

interface IssuedVoucher {
  code: string;
  ssid: string | null;
  durationMinutes: number;
  quota: number;
  locationName: string;
}

const APPROVAL_TYPE_LABELS: Record<string, string> = {
  escalation_reduction:  "Escalation Reduction",
  escalation_waiver:     "Escalation Waiver",
  unifi_adhoc_voucher:   "WiFi Voucher Request",
};

export function ApprovalBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  // After a UniFi voucher is approved, show the code inline before dismissing
  const [issuedVouchers, setIssuedVouchers] = useState<Record<string, IssuedVoucher>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch("/api/approval-requests?status=pending&limit=20");
      if (res.ok) {
        const json = await res.json();
        setApprovals(json.data || []);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchApprovals();
    fetch("/api/me").then(r => r.json()).then(j => setUserRole(j.role || null)).catch(() => {});
    const interval = setInterval(fetchApprovals, 60_000);
    return () => clearInterval(interval);
  }, [fetchApprovals]);

  const pendingCount = approvals.length;

  const handleAction = async (id: string, action: "approve" | "reject") => {
    setActingOnId(id);
    try {
      const body: Record<string, string> = { action };
      if (action === "reject") {
        if (!rejectionReason.trim()) {
          toast.error("Please provide a rejection reason");
          setActingOnId(null);
          return;
        }
        body.rejection_reason = rejectionReason.trim();
      }

      const res = await fetch(`/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = await res.json();
        toast.success(json.message || `Request ${action}d`);

        if (action === "approve" && json.voucher) {
          // Don't remove from list yet — show the code first
          setIssuedVouchers(prev => ({ ...prev, [id]: json.voucher as IssuedVoucher }));
          setApprovals(prev => prev.map(a => a.id === id ? { ...a, status: "approved" } : a));
        } else {
          setApprovals(prev => prev.filter(a => a.id !== id));
        }
        setRejectingId(null);
        setRejectionReason("");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || `Failed to ${action}`);
      }
    } catch {
      toast.error("Network error");
    }
    setActingOnId(null);
  };

  function dismissIssued(id: string) {
    setIssuedVouchers(prev => { const n = { ...prev }; delete n[id]; return n; });
    setApprovals(prev => prev.filter(a => a.id !== id));
  }

  function copyShareable(id: string, voucher: IssuedVoucher) {
    const msg = buildShareableMessage(voucher);
    navigator.clipboard.writeText(msg);
    setCopiedId(id);
    toast.success("Shareable message copied");
    setTimeout(() => setCopiedId(null), 2000);
  }

  // Visible for admin and manager
  if (userRole && !["admin", "manager"].includes(userRole)) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" title="Pending Approvals">
          <ClipboardCheck className="h-4 w-4" />
          {pendingCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-purple-600 text-[10px] font-bold text-white ring-2 ring-background">
              {pendingCount > 9 ? "9+" : pendingCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[400px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-semibold flex items-center gap-1.5">
            <ClipboardCheck className="h-3.5 w-3.5 text-purple-600" />
            Pending Approvals
          </p>
          <Button
            variant="ghost" size="sm" className="h-6 text-xs"
            onClick={() => { setLoading(true); fetchApprovals().finally(() => setLoading(false)); }}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>

        <div className="max-h-[480px] overflow-y-auto">
          {approvals.filter(a => !issuedVouchers[a.id] || true).length === 0 ? (
            <div className="px-4 py-8 text-center">
              <CheckCircle2 className="h-8 w-8 text-green-400 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No pending approvals</p>
            </div>
          ) : (
            approvals.map((a) => {
              const meta = a.metadata || {};
              const isRejecting = rejectingId === a.id;
              const isUnifi = a.entity_type === "unifi_adhoc_voucher";
              const issued = issuedVouchers[a.id];
              const ts = a.requested_at || a.created_at;

              return (
                <div
                  key={a.id}
                  className="border-b last:border-b-0 px-4 py-3 space-y-2 hover:bg-muted/30 transition-colors"
                >
                  {/* Badge + timestamp */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      {isUnifi && <Wifi className="h-3.5 w-3.5 text-primary shrink-0" />}
                      <Badge
                        variant="secondary"
                        className={`text-[10px] px-1.5 py-0 ${isUnifi ? "bg-blue-100 text-blue-800" : "bg-purple-100 text-purple-800"}`}
                      >
                        {APPROVAL_TYPE_LABELS[a.approval_type] || a.approval_type}
                      </Badge>
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0">{ts ? timeAgo(ts) : ""}</span>
                  </div>

                  {/* ── UniFi request details ── */}
                  {isUnifi ? (
                    issued ? (
                      /* ── Issued: show shareable message ── */
                      <div className="space-y-2">
                        <div className="rounded-md bg-green-50 border border-green-200 p-3 space-y-1.5">
                          <p className="text-xs font-semibold text-green-800 flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Voucher Issued
                          </p>
                          <p className="font-mono text-base font-bold tracking-widest text-center py-1">
                            {issued.code}
                          </p>
                          <div className="text-[11px] text-green-700 space-y-0.5">
                            <p>Network: <strong>{issued.ssid ?? "—"}</strong></p>
                            <p>Duration: <strong>{fmtDuration(issued.durationMinutes)}</strong> · Max devices: <strong>{issued.quota}</strong></p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1 h-7 text-xs"
                            onClick={() => copyShareable(a.id, issued)}
                          >
                            {copiedId === a.id
                              ? <><Check className="h-3 w-3 mr-1 text-green-600" /> Copied!</>
                              : <><Copy className="h-3 w-3 mr-1" /> Copy shareable message</>}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-muted-foreground"
                            onClick={() => dismissIssued(a.id)}
                          >
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    ) : (
                      /* ── Pending UniFi request ── */
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          <p>
                            <span className="font-medium text-foreground">
                              {(a.requester as { full_name?: string } | null)?.full_name || "Unknown"}
                            </span>
                            {" "}is requesting a WiFi voucher
                          </p>
                          <p>
                            Location: <span className="font-medium text-foreground">{String(meta.location_name ?? "—")}</span>
                          </p>
                          <p>
                            Duration: <span className="font-medium text-foreground">{fmtDuration(Number(meta.duration_minutes ?? 0))}</span>
                            {" · "}Devices: <span className="font-medium text-foreground">{String(meta.quota ?? 1)}</span>
                          </p>
                          {meta.note != null && (
                            <p>Note: <span className="text-foreground">{String(meta.note)}</span></p>
                          )}
                          {a.reason && (
                            <p className="italic">&ldquo;{a.reason}&rdquo;</p>
                          )}
                        </div>

                        {isRejecting && (
                          <Input
                            autoFocus
                            value={rejectionReason}
                            onChange={(e) => setRejectionReason(e.target.value)}
                            placeholder="Reason for rejection..."
                            className="h-7 text-xs"
                          />
                        )}

                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="flex-1 h-7 text-xs bg-green-600 hover:bg-green-700"
                            disabled={actingOnId === a.id}
                            onClick={() => handleAction(a.id, "approve")}
                          >
                            {actingOnId === a.id
                              ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              : <CheckCircle2 className="h-3 w-3 mr-1" />}
                            Approve & Issue
                          </Button>
                          {isRejecting ? (
                            <Button
                              size="sm" variant="destructive" className="flex-1 h-7 text-xs"
                              disabled={actingOnId === a.id || !rejectionReason.trim()}
                              onClick={() => handleAction(a.id, "reject")}
                            >
                              {actingOnId === a.id
                                ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                : <XCircle className="h-3 w-3 mr-1" />}
                              Confirm Reject
                            </Button>
                          ) : (
                            <Button
                              size="sm" variant="outline" className="flex-1 h-7 text-xs text-destructive hover:text-destructive"
                              onClick={() => { setRejectingId(a.id); setRejectionReason(""); }}
                            >
                              <XCircle className="h-3 w-3 mr-1" />Reject
                            </Button>
                          )}
                        </div>
                      </div>
                    )
                  ) : (
                    /* ── Contract escalation (existing) ── */
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        <p>
                          <span className="font-medium text-foreground">
                            {(a.requester as { full_name?: string } | null)?.full_name || "Unknown"}
                          </span>
                          {" "}requested {a.approval_type === "escalation_waiver" ? "escalation waiver" : "escalation reduction"}
                        </p>
                        {meta.parent_escalation_percentage != null && (
                          <p>
                            Escalation: {String(meta.parent_escalation_percentage)}% → <span className="font-semibold text-foreground">{String(meta.proposed_escalation_percentage)}%</span>
                          </p>
                        )}
                        {meta.parent_subtotal != null && meta.proposed_subtotal != null && (
                          <p>
                            Rate: {formatCurrency(Number(meta.parent_subtotal))}/mo → <span className="font-semibold text-foreground">{formatCurrency(Number(meta.proposed_subtotal))}/mo</span>
                          </p>
                        )}
                        {meta.parent_contract_number ? (
                          <p className="text-[10px]">Renewal of {String(meta.parent_contract_number)}</p>
                        ) : null}
                      </div>

                      <button
                        className="text-xs font-medium text-primary hover:underline"
                        onClick={() => { setOpen(false); router.push(`/contracts/${a.entity_id}`); }}
                      >
                        View contract →
                      </button>

                      {isRejecting && (
                        <Input
                          autoFocus
                          value={rejectionReason}
                          onChange={(e) => setRejectionReason(e.target.value)}
                          placeholder="Reason for rejection..."
                          className="h-7 text-xs"
                        />
                      )}

                      <div className="flex gap-2">
                        <Button
                          size="sm" className="flex-1 h-7 text-xs bg-green-600 hover:bg-green-700"
                          disabled={actingOnId === a.id}
                          onClick={() => handleAction(a.id, "approve")}
                        >
                          {actingOnId === a.id
                            ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            : <CheckCircle2 className="h-3 w-3 mr-1" />}
                          Approve
                        </Button>
                        {isRejecting ? (
                          <Button
                            size="sm" variant="destructive" className="flex-1 h-7 text-xs"
                            disabled={actingOnId === a.id || !rejectionReason.trim()}
                            onClick={() => handleAction(a.id, "reject")}
                          >
                            {actingOnId === a.id
                              ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              : <XCircle className="h-3 w-3 mr-1" />}
                            Confirm Reject
                          </Button>
                        ) : (
                          <Button
                            size="sm" variant="outline" className="flex-1 h-7 text-xs text-destructive hover:text-destructive"
                            onClick={() => { setRejectingId(a.id); setRejectionReason(""); }}
                          >
                            <XCircle className="h-3 w-3 mr-1" />Reject
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

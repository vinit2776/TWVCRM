"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2, XCircle, ClipboardCheck, Loader2, RefreshCw,
  Wifi, Copy, Check, Gift, Receipt,
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

interface PendingBill {
  id: string;
  bill_number: string;
  total_amount: number;
  created_at: string;
  due_date: string | null;
  notes: string | null;
  procurement_vendors: { name: string } | null;
  purchase_orders: { po_number: string } | null;
}

const APPROVAL_TYPE_LABELS: Record<string, string> = {
  escalation_reduction:  "Escalation Reduction",
  escalation_waiver:     "Escalation Waiver",
  unifi_adhoc_voucher:   "WiFi Voucher Request",
  comp_request:          "Comp Request",
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
  const [pendingBills, setPendingBills] = useState<PendingBill[]>([]);
  const [billActingOnId, setBillActingOnId] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      const [approvalsRes, billsRes] = await Promise.all([
        fetch("/api/approval-requests?status=pending&limit=20"),
        fetch("/api/procurement/bills?approval_status=pending&limit=20"),
      ]);
      if (approvalsRes.ok) {
        const json = await approvalsRes.json();
        setApprovals(json.data || []);
      }
      if (billsRes.ok) {
        const json = await billsRes.json();
        setPendingBills(json.data || []);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchApprovals();
    fetch("/api/me").then(r => r.json()).then(j => setUserRole(j.role || null)).catch(() => {});
    // No polling interval — data refreshes on mount and each time the bell is opened.
    // This avoids background DB hits every 60s across all open sessions.
  }, [fetchApprovals]);

  // Refresh whenever the dropdown opens so the list is always up-to-date.
  useEffect(() => {
    if (open) fetchApprovals();
  }, [open, fetchApprovals]);

  const pendingCount = approvals.length + pendingBills.length;

  const handleBillAction = async (bill: PendingBill, action: "approve" | "reject") => {
    setBillActingOnId(bill.id);
    try {
      const res = await fetch(`/api/procurement/bills/${bill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        toast.success(action === "approve" ? `${bill.bill_number} approved` : `${bill.bill_number} rejected`);
        setPendingBills(prev => prev.filter(b => b.id !== bill.id));
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || `Failed to ${action} bill`);
      }
    } catch {
      toast.error("Network error");
    }
    setBillActingOnId(null);
  };

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
          <div className="flex items-center gap-1">
            <Button
              variant="ghost" size="sm" className="h-6 text-xs"
              onClick={() => { setLoading(true); fetchApprovals().finally(() => setLoading(false)); }}
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            </Button>
            <Button
              variant="ghost" size="sm" className="h-6 text-xs"
              onClick={() => { setOpen(false); router.push("/approvals"); }}
            >
              View all
            </Button>
          </div>
        </div>

        <div className="max-h-[480px] overflow-y-auto">
          {approvals.length === 0 && pendingBills.length === 0 ? (
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
                      {a.approval_type === "comp_request" && <Gift className="h-3.5 w-3.5 text-emerald-600 shrink-0" />}
                      <Badge
                        variant="secondary"
                        className={`text-[10px] px-1.5 py-0 ${
                          isUnifi
                            ? "bg-blue-100 text-blue-800"
                            : a.approval_type === "comp_request"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-purple-100 text-purple-800"
                        }`}
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
                  ) : a.approval_type === "comp_request" ? (
                    /* ── Comp request ── */
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        <p>
                          <span className="font-medium text-foreground">
                            {(a.requester as { full_name?: string } | null)?.full_name || "Unknown"}
                          </span>
                          {" "}is requesting to mark{" "}
                          <span className="font-medium text-foreground font-mono">
                            {a.entity_reference ?? a.entity_id}
                          </span>
                          {" "}as complimentary
                        </p>
                        {(() => {
                          const meta = a.metadata || {};
                          return (
                            <>
                              {meta.space_name != null && (
                                <p>Space: <span className="font-medium text-foreground">{String(meta.space_name)}</span></p>
                              )}
                              {meta.reason_label != null && (
                                <p>Reason: <span className="font-medium text-foreground">{String(meta.reason_label)}</span></p>
                              )}
                              {meta.details != null && (
                                <p className="italic">&ldquo;{String(meta.details)}&rdquo;</p>
                              )}
                              {meta.total_amount_with_gst != null && Number(meta.total_amount_with_gst) > 0 && (
                                <p>Total to waive: <span className="font-medium text-foreground">₹{Number(meta.total_amount_with_gst).toLocaleString("en-IN")}</span></p>
                              )}
                            </>
                          );
                        })()}
                      </div>

                      <button
                        className="text-xs font-medium text-primary hover:underline"
                        onClick={() => { setOpen(false); router.push(`/bookings/${a.entity_reference ?? a.entity_id}`); }}
                      >
                        View booking →
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
                          size="sm"
                          className="flex-1 h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
                          disabled={actingOnId === a.id}
                          onClick={() => handleAction(a.id, "approve")}
                        >
                          {actingOnId === a.id
                            ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            : <CheckCircle2 className="h-3 w-3 mr-1" />}
                          Approve Comp
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

          {/* Vendor bills awaiting approval */}
          {pendingBills.length > 0 && (
            <>
              {approvals.length > 0 && (
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/40 border-y">
                  Vendor Bills
                </div>
              )}
              {pendingBills.map((bill) => (
                <div
                  key={bill.id}
                  className="border-b last:border-b-0 px-4 py-3 space-y-2 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Receipt className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-orange-100 text-orange-800">
                        Vendor Bill
                      </Badge>
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(bill.created_at)}</span>
                  </div>

                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <p className="font-medium text-foreground">{bill.bill_number}</p>
                    {bill.procurement_vendors && (
                      <p>Vendor: <span className="font-medium text-foreground">{bill.procurement_vendors.name}</span></p>
                    )}
                    {bill.purchase_orders && (
                      <p>PO: <span className="font-medium text-foreground">{bill.purchase_orders.po_number}</span></p>
                    )}
                    <p>Amount: <span className="font-semibold text-foreground">{formatCurrency(bill.total_amount)}</span></p>
                    {bill.notes && <p className="italic truncate">&ldquo;{bill.notes}&rdquo;</p>}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      className="text-xs font-medium text-primary hover:underline"
                      onClick={() => { setOpen(false); router.push(`/procurement/bills/${bill.id}`); }}
                    >
                      View bill →
                    </button>
                    <div className="flex gap-1.5 ml-auto">
                      <Button
                        size="sm"
                        className="h-7 text-xs bg-green-600 hover:bg-green-700"
                        disabled={billActingOnId === bill.id}
                        onClick={() => handleBillAction(bill, "approve")}
                      >
                        {billActingOnId === bill.id
                          ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          : <CheckCircle2 className="h-3 w-3 mr-1" />}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs text-destructive hover:text-destructive"
                        disabled={billActingOnId === bill.id}
                        onClick={() => { setOpen(false); router.push(`/procurement/bills/${bill.id}`); }}
                      >
                        View to Reject
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

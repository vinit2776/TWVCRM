"use client";

import { useEffect, useState, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import Link from "next/link";
import {
  ClipboardCheck, CheckCircle2, XCircle, Clock, Loader2,
  Gift, RefreshCw, Percent,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { emitApprovalChanged, onApprovalChanged } from "@/lib/approval-events";
import { formatCurrency, apiErrorMessage } from "@/lib/utils";
import { poValidity, PO_VALIDITY_CLASS, waitingSince } from "@/lib/approval-display";
import { computeBatchDate, formatBatchDate, type PaymentBatchType } from "@/lib/payment-batch";
import { PAYMENT_BATCH_TYPES, PAYMENT_BATCH_TYPE_LABELS } from "@/lib/constants";
import { Checkbox } from "@/components/ui/checkbox";
import { Receipt } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  expires_at: string | null;
  requester?: { id: string; full_name: string; email: string; role: string } | null;
  actor?: { id: string; full_name: string } | null;
}

interface PendingBill {
  id: string;
  bill_number: string;
  total_amount: number;
  created_at: string;
  due_date: string | null;
  notes: string | null;
  procurement_vendors: { name: string } | null;
  purchase_orders: { id: string; po_number: string; expected_delivery_date: string | null } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function timeLeft(iso: string): string {
  const diff = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (diff <= 0) return "Expired";
  if (diff < 3600) return `${Math.floor(diff / 60)}m left`;
  return `${Math.floor(diff / 3600)}h left`;
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "approved": return <Badge className="text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border border-emerald-200">Approved</Badge>;
    case "rejected": return <Badge className="text-xs bg-red-100 text-red-700 hover:bg-red-100 border border-red-200">Rejected</Badge>;
    case "expired":  return <Badge className="text-xs bg-slate-100 text-slate-600 hover:bg-slate-100 border border-slate-200">Expired</Badge>;
    default:         return <Badge className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">Pending</Badge>;
  }
}

const TYPE_LABELS: Record<string, string> = {
  comp_request:         "Comp Request",
  escalation_reduction: "Escalation Reduction",
  escalation_waiver:    "Escalation Waiver",
  unifi_adhoc_voucher:  "WiFi Voucher",
};

const ESCALATION_APPROVAL_TYPES = ["escalation_reduction", "escalation_waiver"];

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function CompRequestRow({
  req,
  canAct,
  onActed,
}: {
  req: ApprovalRequest;
  canAct: boolean;
  onActed: () => void;
}) {
  const meta = req.metadata || {};
  const [acting, setActing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  const bookingRef = String(meta.booking_number ?? req.entity_reference ?? req.entity_id);

  const handleAction = async (action: "approve" | "reject") => {
    if (action === "reject" && !rejectionReason.trim()) {
      toast.error("Please provide a rejection reason");
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/approval-requests/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "reject" ? { rejection_reason: rejectionReason.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(apiErrorMessage(json.error, `Failed to ${action}`));
        return;
      }
      toast.success(json.message || `Request ${action}d`);
      emitApprovalChanged();
      onActed();
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-3 hover:bg-muted/10 transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gift className="h-4 w-4 text-emerald-600 shrink-0" />
          <div>
            <div className="flex items-center gap-2">
              <Badge className="text-[10px] px-1.5 py-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                {TYPE_LABELS[req.approval_type] || req.approval_type}
              </Badge>
              <StatusBadge status={req.status} />
            </div>
            <p className="text-sm font-medium mt-0.5">
              <Link href={`/bookings/${bookingRef}`} className="hover:underline text-primary font-mono">
                {bookingRef}
              </Link>
              {meta.space_name ? <span className="text-muted-foreground font-normal"> — {String(meta.space_name)}</span> : null}
            </p>
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(req.requested_at || req.created_at)}</span>
      </div>

      {/* Details */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Requested by: </span>
          {(req.requester as { full_name?: string } | null)?.full_name || "Unknown"}
        </div>
        {meta.total_amount_with_gst != null && Number(meta.total_amount_with_gst) > 0 && (
          <div>
            <span className="font-medium text-foreground">Total to waive: </span>
            ₹{Number(meta.total_amount_with_gst).toLocaleString("en-IN")}
          </div>
        )}
        {meta.reason_label != null && (
          <div>
            <span className="font-medium text-foreground">Reason: </span>
            {String(meta.reason_label)}
          </div>
        )}
        {req.expires_at && req.status === "pending" && (
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            <span className={new Date(req.expires_at) < new Date() ? "text-red-600" : ""}>
              {timeLeft(req.expires_at)}
            </span>
          </div>
        )}
      </div>

      {meta.details != null && (
        <p className="text-xs text-muted-foreground italic border-l-2 border-border pl-2">
          &ldquo;{String(meta.details)}&rdquo;
        </p>
      )}

      {/* Resolved state */}
      {req.status === "rejected" && req.rejection_reason && (
        <p className="text-xs bg-red-50 border border-red-200 rounded px-2 py-1.5 text-red-700">
          <strong>Rejection reason:</strong> {req.rejection_reason}
        </p>
      )}
      {req.status !== "pending" && req.actor && (
        <p className="text-xs text-muted-foreground">
          {req.status === "approved" ? "Approved" : req.status === "rejected" ? "Rejected" : "Handled"} by{" "}
          {(req.actor as { full_name?: string }).full_name || "Unknown"}
          {req.acted_at ? ` · ${timeAgo(req.acted_at)}` : ""}
        </p>
      )}

      {/* Action buttons (pending only, for authorised roles) */}
      {req.status === "pending" && canAct && (
        <div className="space-y-2 pt-1">
          {rejecting && (
            <Input
              autoFocus
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Reason for rejection (required)…"
              className="h-8 text-xs"
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
              disabled={acting}
              onClick={() => handleAction("approve")}
            >
              {acting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
              Approve Comp
            </Button>
            {rejecting ? (
              <Button
                size="sm" variant="destructive" className="flex-1 h-8 text-xs"
                disabled={acting || !rejectionReason.trim()}
                onClick={() => handleAction("reject")}
              >
                {acting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                Confirm Reject
              </Button>
            ) : (
              <Button
                size="sm" variant="outline" className="flex-1 h-8 text-xs text-destructive hover:text-destructive"
                onClick={() => { setRejecting(true); setRejectionReason(""); }}
              >
                <XCircle className="h-3 w-3 mr-1" />Reject
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Escalation approval row (negotiated escalation reduction/waiver on a
// contract renewal — blocks activation until acted on)
// ---------------------------------------------------------------------------

function EscalationApprovalRow({
  req,
  canAct,
  onActed,
}: {
  req: ApprovalRequest;
  canAct: boolean;
  onActed: () => void;
}) {
  const meta = req.metadata || {};
  const [acting, setActing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  const handleAction = async (action: "approve" | "reject") => {
    if (action === "reject" && !rejectionReason.trim()) {
      toast.error("Please provide a rejection reason");
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/approval-requests/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "reject" ? { rejection_reason: rejectionReason.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(apiErrorMessage(json.error, `Failed to ${action}`));
        return;
      }
      toast.success(json.message || `Request ${action}d`);
      emitApprovalChanged();
      onActed();
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-3 hover:bg-muted/10 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Percent className="h-4 w-4 text-purple-600 shrink-0" />
          <div>
            <div className="flex items-center gap-2">
              <Badge className="text-[10px] px-1.5 py-0 bg-purple-100 text-purple-800 hover:bg-purple-100">
                {TYPE_LABELS[req.approval_type] || req.approval_type}
              </Badge>
              <StatusBadge status={req.status} />
            </div>
            <p className="text-sm font-medium mt-0.5">
              <Link href={`/contracts/${req.entity_id}`} className="hover:underline text-primary font-mono">
                {req.entity_reference || req.entity_id}
              </Link>
            </p>
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(req.requested_at || req.created_at)}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Requested by: </span>
          {(req.requester as { full_name?: string } | null)?.full_name || "Unknown"}
        </div>
        {meta.parent_contract_number != null && (
          <div>
            <span className="font-medium text-foreground">Renewal of: </span>
            {String(meta.parent_contract_number)}
          </div>
        )}
        {meta.parent_escalation_percentage != null && (
          <div>
            <span className="font-medium text-foreground">Escalation: </span>
            {String(meta.parent_escalation_percentage)}% → <span className="font-semibold text-foreground">{String(meta.proposed_escalation_percentage)}%</span>
          </div>
        )}
        {meta.parent_subtotal != null && meta.proposed_subtotal != null && (
          <div>
            <span className="font-medium text-foreground">Rate: </span>
            {formatCurrency(Number(meta.parent_subtotal))}/mo → <span className="font-semibold text-foreground">{formatCurrency(Number(meta.proposed_subtotal))}/mo</span>
          </div>
        )}
      </div>

      {req.reason && (
        <p className="text-xs text-muted-foreground italic border-l-2 border-border pl-2">
          &ldquo;{req.reason}&rdquo;
        </p>
      )}

      {req.status === "rejected" && req.rejection_reason && (
        <p className="text-xs bg-red-50 border border-red-200 rounded px-2 py-1.5 text-red-700">
          <strong>Rejection reason:</strong> {req.rejection_reason}
        </p>
      )}
      {req.status !== "pending" && req.actor && (
        <p className="text-xs text-muted-foreground">
          {req.status === "approved" ? "Approved" : req.status === "rejected" ? "Rejected" : "Handled"} by{" "}
          {(req.actor as { full_name?: string }).full_name || "Unknown"}
          {req.acted_at ? ` · ${timeAgo(req.acted_at)}` : ""}
        </p>
      )}

      {req.status === "pending" && canAct && (
        <div className="space-y-2 pt-1">
          {rejecting && (
            <Input
              autoFocus
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Reason for rejection (required)…"
              className="h-8 text-xs"
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
              disabled={acting}
              onClick={() => handleAction("approve")}
            >
              {acting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
              Approve
            </Button>
            {rejecting ? (
              <Button
                size="sm" variant="destructive" className="flex-1 h-8 text-xs"
                disabled={acting || !rejectionReason.trim()}
                onClick={() => handleAction("reject")}
              >
                {acting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                Confirm Reject
              </Button>
            ) : (
              <Button
                size="sm" variant="outline" className="flex-1 h-8 text-xs text-destructive hover:text-destructive"
                onClick={() => { setRejecting(true); setRejectionReason(""); }}
              >
                <XCircle className="h-3 w-3 mr-1" />Reject
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendor bill row
// ---------------------------------------------------------------------------

function VendorBillRow({
  bill,
  canAct,
  selected,
  onToggleSelect,
  onActed,
}: {
  bill: PendingBill;
  canAct: boolean;
  selected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  onActed: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  // Approve is two-step: first click reveals the payment batch chooser,
  // picking a batch fires the request (batch_type is mandatory on the API).
  const [choosingBatch, setChoosingBatch] = useState(false);

  const validity = poValidity(bill.purchase_orders?.expected_delivery_date);
  const waiting = waitingSince(bill.created_at);

  const handleAction = async (action: "approve" | "reject", batchType?: PaymentBatchType) => {
    if (action === "reject" && !rejectionReason.trim()) {
      toast.error("Please provide a rejection reason");
      return;
    }
    if (action === "approve" && !batchType) {
      toast.error("Select a payment batch schedule");
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/procurement/bills/${bill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "approve" ? { batch_type: batchType } : {}),
          ...(action === "reject" ? { rejection_reason: rejectionReason.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        toast.error(apiErrorMessage(json?.error, `Failed to ${action} bill`));
        return;
      }
      toast.success(action === "approve" ? `${bill.bill_number} approved` : `${bill.bill_number} rejected`);
      setChoosingBatch(false);
      emitApprovalChanged();
      onActed();
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-3 hover:bg-muted/10 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {canAct && (
            <Checkbox
              checked={selected}
              onCheckedChange={(c) => onToggleSelect(bill.id, !!c)}
              aria-label={`Select ${bill.bill_number}`}
              className="mt-1"
            />
          )}
          <Receipt className="h-4 w-4 text-purple-600 shrink-0 mt-0.5" />
          <div>
            <Link
              href={`/procurement/bills/${bill.id}`}
              className="font-medium text-sm hover:underline"
            >
              {bill.bill_number}
            </Link>
            <p className="text-xs text-muted-foreground">
              {bill.procurement_vendors?.name || "Unknown vendor"}
              {bill.purchase_orders?.po_number && ` · PO ${bill.purchase_orders.po_number}`}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="font-semibold text-sm">{formatCurrency(bill.total_amount)}</span>
          {waiting && <span className="text-[10px] text-amber-700">{waiting}</span>}
        </div>
      </div>

      {validity && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] ${PO_VALIDITY_CLASS[validity.tone]}`}>
            {validity.label}
          </Badge>
        </div>
      )}

      {canAct && (
        <div className="space-y-2">
          {rejecting && (
            <Input
              autoFocus
              placeholder="Reason for rejection (required)"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              className="h-8 text-xs"
            />
          )}
          {choosingBatch && !rejecting && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">When should accounts process this payment?</p>
              <div className="grid grid-cols-3 gap-1.5">
                {PAYMENT_BATCH_TYPES.map((bt) => (
                  <button
                    key={bt}
                    type="button"
                    disabled={acting}
                    onClick={() => handleAction("approve", bt)}
                    className="rounded-md border border-emerald-200 bg-emerald-50/50 px-2 py-1.5 text-left hover:bg-emerald-100 transition-colors disabled:opacity-50"
                  >
                    <p className="text-xs font-semibold">{PAYMENT_BATCH_TYPE_LABELS[bt]}</p>
                    <p className="text-[10px] text-muted-foreground">{formatBatchDate(computeBatchDate(bt))}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            {!rejecting ? (
              choosingBatch ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-8 text-xs"
                  disabled={acting}
                  onClick={() => setChoosingBatch(false)}
                >
                  {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Cancel"}
                </Button>
              ) : (
              <>
                <Button
                  size="sm"
                  className="flex-1 h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
                  disabled={acting}
                  onClick={() => setChoosingBatch(true)}
                >
                  {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : (<><CheckCircle2 className="h-3 w-3 mr-1" />Approve</>)}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-8 text-xs text-destructive hover:text-destructive"
                  onClick={() => { setRejecting(true); setRejectionReason(""); }}
                >
                  <XCircle className="h-3 w-3 mr-1" />Reject
                </Button>
              </>
              )
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-8 text-xs"
                  onClick={() => { setRejecting(false); setRejectionReason(""); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-8 text-xs bg-destructive hover:bg-destructive/90"
                  disabled={acting}
                  onClick={() => handleAction("reject")}
                >
                  {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm Reject"}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApprovalsPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const userRole = user?.role ?? null;
  const userId = user?.id ?? null;
  const [requests, setRequests]     = useState<ApprovalRequest[]>([]);
  const [escalationRequests, setEscalationRequests] = useState<ApprovalRequest[]>([]);
  const [history, setHistory]       = useState<ApprovalRequest[]>([]);
  const [pendingBills, setPendingBills] = useState<PendingBill[]>([]);
  const [selectedBillIds, setSelectedBillIds] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkBatchType, setBulkBatchType] = useState<PaymentBatchType | "">("");
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const isApprover = userRole === "admin" || userRole === "manager";
  const canActOnBills = userRole === "admin";

  const fetchData = useCallback(async () => {
    try {
      // Fetch pending
      const pendingRes = await fetch("/api/approval-requests?status=pending&limit=50");
      if (pendingRes.ok) {
        const json = await pendingRes.json();
        const all = (json.data || []) as ApprovalRequest[];
        // Floor managers only see their own comp requests
        setRequests(
          isApprover
            ? all.filter(r => r.approval_type === "comp_request")
            : all.filter(r => r.approval_type === "comp_request" && r.requested_by === userId)
        );
        // Escalation reduction/waiver requests can only be acted on by
        // admin/manager (see PATCH /api/approval-requests/[id]), so only
        // approvers need to see them here.
        setEscalationRequests(
          isApprover ? all.filter(r => ESCALATION_APPROVAL_TYPES.includes(r.approval_type)) : []
        );
      }

      // Fetch pending vendor bills (only admins/managers see them — admins can act)
      if (isApprover) {
        const billsRes = await fetch("/api/procurement/bills?approval_status=pending&limit=50");
        if (billsRes.ok) {
          const json = await billsRes.json();
          setPendingBills((json.data || []) as PendingBill[]);
        }
      } else {
        setPendingBills([]);
      }

      // Fetch recent resolved (last 30 days)
      const historyRes = await fetch("/api/approval-requests?limit=100");
      if (historyRes.ok) {
        const json = await historyRes.json();
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const resolved = ((json.data || []) as ApprovalRequest[]).filter(
          r => (r.approval_type === "comp_request" || ESCALATION_APPROVAL_TYPES.includes(r.approval_type))
            && r.status !== "pending"
            && new Date(r.created_at) > cutoff
            && (isApprover || r.requested_by === userId)
        );
        setHistory(resolved);
      }
    } finally {
      setLoading(false);
    }
  }, [isApprover, userId]);

  useEffect(() => {
    if (!userLoading && userRole !== null) fetchData();
  }, [userLoading, userRole, fetchData]);

  // Listen for approval mutations from elsewhere in the app so this page
  // stays in sync without the user clicking refresh.
  useEffect(() => {
    return onApprovalChanged(() => { fetchData(); });
  }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const toggleBillSelected = (id: string, checked: boolean) => {
    setSelectedBillIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const toggleAllBills = (checked: boolean) => {
    setSelectedBillIds(checked ? new Set(pendingBills.map(b => b.id)) : new Set());
  };

  const handleBulkApprove = async () => {
    if (selectedBillIds.size === 0) return;
    if (!bulkBatchType) {
      toast.error("Select a payment batch schedule for the selected bills");
      return;
    }
    setBulkApproving(true);
    const ids = Array.from(selectedBillIds);
    const results = await Promise.allSettled(
      ids.map(id =>
        fetch(`/api/procurement/bills/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve", batch_type: bulkBatchType }),
        }).then(async r => {
          if (!r.ok) {
            const json = await r.json().catch(() => null);
            throw new Error(apiErrorMessage(json?.error, "Failed"));
          }
        })
      )
    );
    const ok = results.filter(r => r.status === "fulfilled").length;
    const failed = results.length - ok;
    if (ok > 0) toast.success(`${ok} bill${ok === 1 ? "" : "s"} approved`);
    if (failed > 0) toast.error(`${failed} failed — open them individually to see why`);
    setSelectedBillIds(new Set());
    emitApprovalChanged();
    await fetchData();
    setBulkApproving(false);
  };

  return (
    <div className="container max-w-3xl py-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-purple-600" />
            Approvals
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isApprover
              ? "Review and act on pending approval requests."
              : "Track the status of your approval requests."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : (
        <Tabs defaultValue="pending">
          <TabsList className="w-full">
            <TabsTrigger value="pending" className="flex-1">
              Pending
              {(requests.length + pendingBills.length + escalationRequests.length) > 0 && (
                <Badge className="ml-2 text-[10px] bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">
                  {requests.length + pendingBills.length + escalationRequests.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="flex-1">
              History
              {history.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-[10px]">{history.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Pending tab */}
          <TabsContent value="pending" className="mt-4 space-y-6">
            {requests.length === 0 && pendingBills.length === 0 && escalationRequests.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <CheckCircle2 className="h-10 w-10 text-green-400 mx-auto mb-3" />
                  <p className="text-sm font-medium">All clear</p>
                  <p className="text-xs text-muted-foreground mt-1">No pending approval requests.</p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Vendor Bills section */}
                {pendingBills.length > 0 && (
                  <section className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Receipt className="h-4 w-4 text-purple-600" />
                        <h2 className="text-sm font-semibold">
                          Vendor Bills <span className="text-muted-foreground font-normal">({pendingBills.length})</span>
                        </h2>
                      </div>
                      {canActOnBills && (
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                            <Checkbox
                              checked={pendingBills.length > 0 && selectedBillIds.size === pendingBills.length}
                              onCheckedChange={(c) => toggleAllBills(!!c)}
                            />
                            Select all
                          </label>
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
                            disabled={selectedBillIds.size === 0 || !bulkBatchType || bulkApproving}
                            onClick={handleBulkApprove}
                          >
                            {bulkApproving ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <><CheckCircle2 className="h-3 w-3 mr-1" />Approve {selectedBillIds.size > 0 ? `${selectedBillIds.size} selected` : "Selected"}</>
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                    {canActOnBills && selectedBillIds.size > 0 && (
                      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                        <span className="text-xs text-muted-foreground shrink-0">Payment batch:</span>
                        <div className="flex gap-1.5">
                          {PAYMENT_BATCH_TYPES.map((bt) => (
                            <button
                              key={bt}
                              type="button"
                              onClick={() => setBulkBatchType(bt)}
                              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                                bulkBatchType === bt
                                  ? "border-emerald-500 bg-emerald-50 text-emerald-900 font-semibold"
                                  : "border-muted hover:bg-muted/50"
                              }`}
                            >
                              {PAYMENT_BATCH_TYPE_LABELS[bt]}
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                {formatBatchDate(computeBatchDate(bt))}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {pendingBills.map(bill => (
                      <VendorBillRow
                        key={bill.id}
                        bill={bill}
                        canAct={canActOnBills}
                        selected={selectedBillIds.has(bill.id)}
                        onToggleSelect={toggleBillSelected}
                        onActed={fetchData}
                      />
                    ))}
                  </section>
                )}

                {/* Escalation Approvals section — blocks contract activation until acted on */}
                {escalationRequests.length > 0 && (
                  <section className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Percent className="h-4 w-4 text-purple-600" />
                      <h2 className="text-sm font-semibold">
                        Escalation Approvals <span className="text-muted-foreground font-normal">({escalationRequests.length})</span>
                      </h2>
                    </div>
                    {escalationRequests.map(req => (
                      <EscalationApprovalRow
                        key={req.id}
                        req={req}
                        canAct={isApprover}
                        onActed={fetchData}
                      />
                    ))}
                  </section>
                )}

                {/* Comp Requests section */}
                {requests.length > 0 && (
                  <section className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Gift className="h-4 w-4 text-emerald-600" />
                      <h2 className="text-sm font-semibold">
                        Comp Requests <span className="text-muted-foreground font-normal">({requests.length})</span>
                      </h2>
                    </div>
                    {requests.map(req => (
                      <CompRequestRow
                        key={req.id}
                        req={req}
                        canAct={isApprover}
                        onActed={fetchData}
                      />
                    ))}
                  </section>
                )}
              </>
            )}
          </TabsContent>

          {/* History tab */}
          <TabsContent value="history" className="mt-4 space-y-3">
            {history.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">No resolved requests in the last 30 days.</p>
                </CardContent>
              </Card>
            ) : (
              history.map(req => (
                ESCALATION_APPROVAL_TYPES.includes(req.approval_type) ? (
                  <EscalationApprovalRow
                    key={req.id}
                    req={req}
                    canAct={false}
                    onActed={fetchData}
                  />
                ) : (
                  <CompRequestRow
                    key={req.id}
                    req={req}
                    canAct={false}
                    onActed={fetchData}
                  />
                )
              ))
            )}

            {history.length > 0 && (
              <p className="text-xs text-center text-muted-foreground py-2">
                Showing resolved requests from the last 30 days.
              </p>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

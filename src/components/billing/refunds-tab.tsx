"use client";

/**
 * RefundsTab — finance approval queue for refund requests created by
 * the cancellation flow.
 *
 * Two leg workflow (locked policy):
 *   1. Approval — manager / admin reviews and either approves or
 *      rejects. A rejected request flips the booking's
 *      gst_invoice_required flag so finance issues the invoice for
 *      the kept amount.
 *   2. Processing — once approved, finance (admin / manager /
 *      accounts) records the refund method + reference (NEFT ID /
 *      cash voucher # / gateway refund ID) and the request is marked
 *      processed.
 *
 * Sub-tabs: Pending Approval / Approved (awaiting refund) /
 *           Processed-or-rejected (history)
 */

import { useEffect, useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2, Check, X, IndianRupee, Clock, Ban,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import {
  REFUND_REQUEST_REASON_LABELS,
  REFUND_REQUEST_STATUS_COLORS,
  REFUND_REQUEST_STATUS_LABELS,
} from "@/lib/constants";
import type { RefundRequest } from "@/types";

type SubTab = "pending_approval" | "approved" | "history";

export function RefundsTab() {
  const [activeSub, setActiveSub] = useState<SubTab>("pending_approval");
  const [requests, setRequests] = useState<RefundRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // Sub-dialogs — only one open at a time
  const [rejecting, setRejecting] = useState<RefundRequest | null>(null);
  const [processing, setProcessing] = useState<RefundRequest | null>(null);
  const [acting, setActing] = useState(false);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      // Map sub-tab → status filter. "history" pulls both rejected
      // and processed since neither needs further action.
      const statusFilter =
        activeSub === "pending_approval" ? "pending_approval"
        : activeSub === "approved" ? "approved"
        : "rejected,processed";
      const res = await fetch(`/api/refund-requests?status=${statusFilter}`);
      const json = await res.json();
      setRequests(json.data || []);
    } finally {
      setLoading(false);
    }
  }, [activeSub]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const approve = async (rr: RefundRequest) => {
    if (!confirm(`Approve refund of ${formatCurrency(rr.amount_requested)}? Finance will then process the actual refund.`)) return;
    setActing(true);
    try {
      const res = await fetch(`/api/refund-requests/${rr.id}/approve`, { method: "PATCH" });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to approve"); return; }
      toast.success("Approved — finance can now process");
      await fetchRequests();
    } finally { setActing(false); }
  };

  return (
    <div className="space-y-3">
      <Tabs value={activeSub} onValueChange={(v) => setActiveSub(v as SubTab)}>
        <TabsList>
          <TabsTrigger value="pending_approval">
            <Clock className="h-3.5 w-3.5 mr-1" />Pending Approval
          </TabsTrigger>
          <TabsTrigger value="approved">
            <IndianRupee className="h-3.5 w-3.5 mr-1" />Approved — Awaiting Refund
          </TabsTrigger>
          <TabsTrigger value="history">
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeSub} className="mt-3">
          {loading ? (
            <div className="text-sm text-muted-foreground py-6 text-center flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : requests.length === 0 ? (
            <div className="text-sm text-muted-foreground italic py-6 text-center">
              {activeSub === "pending_approval"
                ? "No refund requests awaiting approval."
                : activeSub === "approved"
                  ? "No approved refunds awaiting processing."
                  : "No history yet."}
            </div>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Booking</th>
                    <th className="text-left px-3 py-2 font-medium">Customer</th>
                    <th className="text-right px-3 py-2 font-medium">Amount</th>
                    <th className="text-left px-3 py-2 font-medium">Reason</th>
                    <th className="text-left px-3 py-2 font-medium">Requested</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-right px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((rr) => {
                    const customerName = rr.booking?.lead
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      ? `${(rr.booking.lead as any).first_name} ${(rr.booking.lead as any).last_name}`
                      : "—";
                    return (
                      <tr key={rr.id} className="border-t hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono text-xs">
                          {rr.booking?.booking_number ? (
                            <Link
                              href={`/bookings/${rr.booking_id}`}
                              target="_blank"
                              rel="noopener"
                              className="text-primary hover:underline"
                            >
                              {rr.booking.booking_number}
                            </Link>
                          ) : "—"}
                          {rr.booking?.booking_date && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {formatDate(rr.booking.booking_date)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">{customerName}</td>
                        <td className="px-3 py-2 text-right font-semibold">
                          {formatCurrency(Number(rr.amount_requested))}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div>{REFUND_REQUEST_REASON_LABELS[rr.reason] || rr.reason}</div>
                          {rr.details && (
                            <div className="text-[10px] text-muted-foreground mt-0.5 max-w-[220px] truncate" title={rr.details}>
                              {rr.details}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div>{formatDate(rr.requested_at)}</div>
                          <div className="text-[10px] text-muted-foreground">
                            by {rr.requester?.full_name || "—"}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            variant="secondary"
                            className={`text-[10px] ${REFUND_REQUEST_STATUS_COLORS[rr.status] || ""}`}
                          >
                            {REFUND_REQUEST_STATUS_LABELS[rr.status] || rr.status}
                          </Badge>
                          {rr.status === "rejected" && rr.rejected_reason && (
                            <div className="text-[10px] text-red-700 mt-1 max-w-[200px]" title={rr.rejected_reason}>
                              {rr.rejected_reason.slice(0, 40)}{rr.rejected_reason.length > 40 ? "…" : ""}
                            </div>
                          )}
                          {rr.status === "processed" && (
                            <div className="text-[10px] text-muted-foreground mt-1">
                              {rr.refund_method} · {rr.refund_reference}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {rr.status === "pending_approval" && (
                            <div className="flex gap-1 justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200"
                                onClick={() => approve(rr)}
                                disabled={acting}
                              >
                                <Check className="h-3 w-3 mr-1" />Approve
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs bg-red-50 hover:bg-red-100 text-red-700 border-red-200"
                                onClick={() => setRejecting(rr)}
                              >
                                <X className="h-3 w-3 mr-1" />Reject
                              </Button>
                            </div>
                          )}
                          {rr.status === "approved" && (
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => setProcessing(rr)}
                            >
                              <IndianRupee className="h-3 w-3 mr-1" />Record Refund
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {rejecting && (
        <RejectDialog
          request={rejecting}
          onClose={() => setRejecting(null)}
          onSubmitted={fetchRequests}
        />
      )}
      {processing && (
        <ProcessDialog
          request={processing}
          onClose={() => setProcessing(null)}
          onSubmitted={fetchRequests}
        />
      )}
    </div>
  );
}

// ── Reject sub-dialog ────────────────────────────────────────────────

function RejectDialog({
  request, onClose, onSubmitted,
}: { request: RefundRequest; onClose: () => void; onSubmitted: () => void }) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reason.trim()) {
      toast.error("Please enter a rejection reason");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/refund-requests/${request.id}/reject`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rejected_reason: reason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to reject");
        return;
      }
      toast.success("Rejected — booking flagged for GST invoice");
      onSubmitted();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <Ban className="h-4 w-4" />
            Reject refund — {request.booking?.booking_number}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-muted/30 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount requested</span>
              <span className="font-semibold">{formatCurrency(Number(request.amount_requested))}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Staff reason</span>
              <span>{REFUND_REQUEST_REASON_LABELS[request.reason] || request.reason}</span>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="reject-reason">Why are you rejecting? *</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Will be visible to the staff who requested + on the booking audit trail"
              rows={3}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            On reject, the payment is retained and the booking is flagged for finance to issue a GST invoice.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={submit}
              disabled={submitting || !reason.trim()}
            >
              {submitting
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Rejecting…</>
                : "Reject refund"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Process sub-dialog ───────────────────────────────────────────────

function ProcessDialog({
  request, onClose, onSubmitted,
}: { request: RefundRequest; onClose: () => void; onSubmitted: () => void }) {
  const [method, setMethod] = useState<"bank_transfer" | "cash" | "gateway" | "other">("bank_transfer");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const methodLabels: Record<string, string> = {
    bank_transfer: "Bank transfer (NEFT/IMPS/UPI)",
    cash:          "Cash",
    gateway:       "Razorpay refund",
    other:         "Other",
  };

  const submit = async () => {
    if (!reference.trim()) {
      toast.error("Reference is required (transaction ID / voucher # / refund ID)");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/refund-requests/${request.id}/process`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refund_method: method,
          refund_reference: reference.trim(),
          notes: notes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to record refund");
        return;
      }
      toast.success("Refund recorded");
      onSubmitted();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IndianRupee className="h-4 w-4 text-emerald-600" />
            Record refund — {request.booking?.booking_number}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-sm">
            <div className="font-semibold">{formatCurrency(Number(request.amount_requested))}</div>
            <div className="text-[11px] text-emerald-900 mt-0.5">
              Approved by {request.approver?.full_name || "—"} on {request.approved_at ? formatDateTime(request.approved_at) : "—"}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Refund method *</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(methodLabels) as Array<keyof typeof methodLabels>).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m as typeof method)}
                  className={`text-left rounded-md border px-3 py-2 text-xs transition-colors ${
                    method === m
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  {methodLabels[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ref">
              Reference *
              <span className="text-[11px] text-muted-foreground font-normal ml-1.5">
                (NEFT ID / cash voucher # / gateway refund ID)
              </span>
            </Label>
            <Input
              id="ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. NEFTABC123456"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="notes" className="text-xs">Notes (optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button
              onClick={submit}
              disabled={submitting || !reference.trim()}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {submitting
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Recording…</>
                : "Record refund"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

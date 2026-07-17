"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Wallet, CheckCircle2, XCircle, Clock, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { DepositAdjustment, DepositAdjustmentStatus } from "@/types";

interface Props {
  contractId: string;
  currentUserId: string | null;
  currentUserRole: string;
}

const STATUS_ICON: Record<DepositAdjustmentStatus, React.ReactNode> = {
  pending_approval: <Clock className="h-3.5 w-3.5" />,
  approved: <CheckCircle2 className="h-3.5 w-3.5" />,
  rejected: <XCircle className="h-3.5 w-3.5" />,
  reversed: <RotateCcw className="h-3.5 w-3.5" />,
};

const STATUS_VARIANT: Record<DepositAdjustmentStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending_approval: "secondary",
  approved: "default",
  rejected: "destructive",
  reversed: "outline",
};

const STATUS_LABEL: Record<DepositAdjustmentStatus, string> = {
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  reversed: "Reversed",
};

export function ContractDepositAdjustmentsSection({ contractId, currentUserId, currentUserRole }: Props) {
  const [items, setItems] = useState<DepositAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [approveOpen, setApproveOpen] = useState<DepositAdjustment | null>(null);
  const [rejectOpen, setRejectOpen] = useState<DepositAdjustment | null>(null);
  const [reverseOpen, setReverseOpen] = useState<DepositAdjustment | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canAuthorize = ["admin", "manager"].includes(currentUserRole);
  const canReverse = currentUserRole === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/deposit-adjustments`);
      if (res.ok) {
        const { data } = await res.json();
        setItems(data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(item: DepositAdjustment, action: "approve" | "reject") {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/deposit-adjustments/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: reason.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to update adjustment");
        return;
      }
      toast.success(`Deposit adjustment ${action === "approve" ? "approved" : "rejected"}`);
      setApproveOpen(null);
      setRejectOpen(null);
      setReason("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReverse(item: DepositAdjustment) {
    if (!reason.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/deposit-adjustments/${item.id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to reverse adjustment");
        return;
      }
      toast.success("Deposit adjustment reversed");
      setReverseOpen(null);
      setReason("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  if (!loading && items.length === 0) return null;

  const pendingCount = items.filter((i) => i.status === "pending_approval").length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Wallet className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Deposit Adjustments</span>
        {pendingCount > 0 && (
          <Badge variant="secondary" className="text-xs">{pendingCount} pending</Badge>
        )}
      </div>

      {loading && <p className="text-xs text-muted-foreground">Loading…</p>}

      {!loading && (
        <div className="space-y-2">
          {items.map((item) => {
            const isOwnRequest = currentUserId != null && item.requested_by === currentUserId;
            return (
              <div key={item.id} className="rounded-md border px-3 py-2.5 text-sm flex items-start justify-between gap-3">
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge variant={STATUS_VARIANT[item.status]} className="text-xs gap-1">
                      {STATUS_ICON[item.status]}
                      {STATUS_LABEL[item.status]}
                    </Badge>
                    <span className="font-medium">{formatCurrency(item.amount)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Requested by {item.requested_by_name ?? "—"} on {formatDate(item.requested_at)}
                    {item.status === "approved" && item.approved_by_name && (
                      <> · Approved by {item.approved_by_name} on {formatDate(item.approved_at!)}</>
                    )}
                    {item.status === "rejected" && item.rejected_by_name && (
                      <> · Rejected by {item.rejected_by_name} on {formatDate(item.rejected_at!)}</>
                    )}
                    {item.status === "reversed" && item.reversed_by_name && (
                      <> · Reversed by {item.reversed_by_name} on {formatDate(item.reversed_at!)}</>
                    )}
                  </p>
                  {item.rejection_reason && (
                    <p className="text-xs italic text-muted-foreground">Reason: {item.rejection_reason}</p>
                  )}
                  {item.reversal_reason && (
                    <p className="text-xs italic text-muted-foreground">Reversal reason: {item.reversal_reason}</p>
                  )}
                </div>

                <div className="flex gap-1.5 shrink-0">
                  {item.status === "pending_approval" && canAuthorize && !isOwnRequest && (
                    <>
                      <Button size="sm" className="h-7 text-xs" onClick={() => setApproveOpen(item)}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRejectOpen(item)}>
                        Reject
                      </Button>
                    </>
                  )}
                  {item.status === "pending_approval" && canAuthorize && isOwnRequest && (
                    <span className="text-xs text-muted-foreground italic">Awaiting a different approver</span>
                  )}
                  {item.status === "approved" && canReverse && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setReverseOpen(item)}>
                      Reverse
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Approve dialog */}
      <Dialog open={!!approveOpen} onOpenChange={() => { setApproveOpen(null); setReason(""); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Approve Deposit Adjustment</DialogTitle>
            <DialogDescription>
              This reduces the available security deposit by{" "}
              <strong>{approveOpen ? formatCurrency(approveOpen.amount) : ""}</strong> and settles it against
              the linked invoice. Accounts and (if opted in) the customer will be notified by email.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(null)}>Cancel</Button>
            <Button onClick={() => approveOpen && handleAction(approveOpen, "approve")} disabled={submitting}>
              {submitting ? "Approving…" : "Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={!!rejectOpen} onOpenChange={() => { setRejectOpen(null); setReason(""); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Deposit Adjustment</DialogTitle>
            <DialogDescription>The deposit balance is unaffected; accounts will need to record payment another way.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>Reason for rejection</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Let the requester know why…" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => rejectOpen && handleAction(rejectOpen, "reject")} disabled={submitting || !reason.trim()}>
              {submitting ? "Rejecting…" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reverse dialog */}
      <Dialog open={!!reverseOpen} onOpenChange={() => { setReverseOpen(null); setReason(""); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse Deposit Adjustment</DialogTitle>
            <DialogDescription>
              Restores <strong>{reverseOpen ? formatCurrency(reverseOpen.amount) : ""}</strong> to the available
              deposit balance and removes the linked payment from the invoice. This unblocks voiding the statement if needed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>Reason for reversal</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why is this being reversed…" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseOpen(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => reverseOpen && handleReverse(reverseOpen)} disabled={submitting || !reason.trim()}>
              {submitting ? "Reversing…" : "Reverse"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

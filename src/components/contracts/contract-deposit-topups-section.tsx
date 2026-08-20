"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { PlusCircle, Link2, Banknote, Clock, CheckCircle2, RotateCcw, AlertTriangle, XCircle } from "lucide-react";
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
import {
  DEPOSIT_TOPUP_CATEGORY_LABELS,
  type DepositTopup,
  type DepositTopupStatus,
} from "@/types";
import { DepositCollectDialog } from "@/components/contracts/deposit-collect-dialog";

interface Props {
  contractId: string;
  currentUserRole: string;
  /** contracts.deposit_shortfall — renders an actionable callout when > 0. */
  depositShortfall?: number | null;
  /** Called after a top-up collects money toward the shortfall, so the parent can refresh its own display. */
  onShortfallCollected?: () => void;
}

const STATUS_ICON: Record<DepositTopupStatus, React.ReactNode> = {
  pending: <Clock className="h-3.5 w-3.5" />,
  paid: <CheckCircle2 className="h-3.5 w-3.5" />,
  reversed: <RotateCcw className="h-3.5 w-3.5" />,
  cancelled: <XCircle className="h-3.5 w-3.5" />,
};

const STATUS_VARIANT: Record<DepositTopupStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  paid: "default",
  reversed: "outline",
  cancelled: "outline",
};

const STATUS_LABEL: Record<DepositTopupStatus, string> = {
  pending: "Awaiting payment",
  paid: "Paid",
  reversed: "Reversed",
  cancelled: "Cancelled",
};

export function ContractDepositTopupsSection({ contractId, currentUserRole, depositShortfall, onShortfallCollected }: Props) {
  const [items, setItems] = useState<DepositTopup[]>([]);
  const [loading, setLoading] = useState(true);
  const [collectOpen, setCollectOpen] = useState(false);
  const [collectPrefillsShortfall, setCollectPrefillsShortfall] = useState(false);
  const [reverseOpen, setReverseOpen] = useState<DepositTopup | null>(null);
  const [cancelOpen, setCancelOpen] = useState<DepositTopup | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canCollect = ["admin", "manager", "accounts"].includes(currentUserRole);
  const canReverse = currentUserRole === "admin";
  const hasShortfall = (depositShortfall ?? 0) > 0;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/deposit-topups`);
      if (res.ok) {
        const { data } = await res.json();
        setItems(data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => { load(); }, [load]);

  function openCollectDialog(prefillShortfall: boolean) {
    setCollectPrefillsShortfall(prefillShortfall);
    setCollectOpen(true);
  }

  async function handleReverse(item: DepositTopup) {
    if (!reason.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/deposit-topups/${item.id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to reverse top-up"); return; }
      toast.success("Top-up reversed");
      setReverseOpen(null);
      setReason("");
      await load();
      if (item.applies_to_shortfall) onShortfallCollected?.();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(item: DepositTopup) {
    if (!reason.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/deposit-topups/${item.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to cancel top-up"); return; }
      toast.success("Top-up cancelled");
      setCancelOpen(null);
      setReason("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  if (!canCollect && !hasShortfall && !loading && items.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PlusCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Deposit Top-ups</span>
        </div>
        {canCollect && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openCollectDialog(false)}>
            Collect Additional Deposit
          </Button>
        )}
      </div>

      {hasShortfall && canCollect && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Renewal escalation shortfall: <strong>{formatCurrency(depositShortfall ?? 0)}</strong> still to collect</span>
          </div>
          <Button size="sm" className="h-7 text-xs shrink-0" onClick={() => openCollectDialog(true)}>
            Collect Now
          </Button>
        </div>
      )}

      {loading && <p className="text-xs text-muted-foreground">Loading…</p>}

      {!loading && items.length > 0 && (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-md border px-3 py-2.5 text-sm flex items-start justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge variant={STATUS_VARIANT[item.status]} className="text-xs gap-1">
                    {STATUS_ICON[item.status]}
                    {STATUS_LABEL[item.status]}
                  </Badge>
                  <span className="font-medium">{formatCurrency(item.amount)}</span>
                  <Badge variant="outline" className="text-xs">{DEPOSIT_TOPUP_CATEGORY_LABELS[item.category]}</Badge>
                  {item.collection_method === "razorpay_link" ? (
                    <Link2 className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <Banknote className="h-3 w-3 text-muted-foreground" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {item.category_note && <>{item.category_note} · </>}
                  Created by {item.created_by_name ?? "—"} on {formatDate(item.created_at)}
                  {item.status === "paid" && item.paid_at && <> · Paid {formatDate(item.paid_at)}</>}
                  {item.status === "reversed" && item.reversed_by_name && (
                    <> · Reversed by {item.reversed_by_name} on {formatDate(item.reversed_at!)}</>
                  )}
                  {item.status === "cancelled" && item.cancelled_by_name && (
                    <> · Cancelled by {item.cancelled_by_name} on {formatDate(item.cancelled_at!)}</>
                  )}
                </p>
                {item.reversal_reason && (
                  <p className="text-xs italic text-muted-foreground">Reversal reason: {item.reversal_reason}</p>
                )}
                {item.cancellation_reason && (
                  <p className="text-xs italic text-muted-foreground">Cancellation reason: {item.cancellation_reason}</p>
                )}
              </div>
              {item.status === "paid" && canReverse && (
                <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => setReverseOpen(item)}>
                  Reverse
                </Button>
              )}
              {item.status === "pending" && canReverse && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs shrink-0 text-amber-700 hover:text-amber-800"
                  onClick={() => setCancelOpen(item)}
                  title="Withdraw this request and cancel its payment link"
                >
                  Cancel
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Collect dialog */}
      <DepositCollectDialog
        contractId={contractId}
        open={collectOpen}
        onOpenChange={setCollectOpen}
        prefillShortfall={collectPrefillsShortfall ? depositShortfall : null}
        onCollected={() => {
          load();
          if (collectPrefillsShortfall) onShortfallCollected?.();
        }}
      />

      {/* Reverse dialog */}
      <Dialog open={!!reverseOpen} onOpenChange={() => { setReverseOpen(null); setReason(""); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse Deposit Top-up</DialogTitle>
            <DialogDescription>
              Removes <strong>{reverseOpen ? formatCurrency(reverseOpen.amount) : ""}</strong> from the available
              deposit balance{reverseOpen?.applies_to_shortfall ? " and restores the shortfall figure" : ""}.
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

      {/* Cancel dialog — pending only */}
      <Dialog open={!!cancelOpen} onOpenChange={() => { setCancelOpen(null); setReason(""); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Deposit Top-up</DialogTitle>
            <DialogDescription>
              Withdraws the request for <strong>{cancelOpen ? formatCurrency(cancelOpen.amount) : ""}</strong> and
              cancels its payment link so the customer can no longer pay it. It stops appearing in
              Accounts Receivable and stops being chased. No money has changed hands, so nothing is
              refunded or restored.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>Reason for cancellation</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why is this being cancelled…" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(null)}>Keep it</Button>
            <Button variant="destructive" onClick={() => cancelOpen && handleCancel(cancelOpen)} disabled={submitting || !reason.trim()}>
              {submitting ? "Cancelling…" : "Cancel Top-up"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

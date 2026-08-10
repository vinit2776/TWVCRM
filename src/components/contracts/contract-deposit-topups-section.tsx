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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatDate, formatCurrency } from "@/lib/utils";
import {
  DEPOSIT_TOPUP_CATEGORY_LABELS,
  type DepositTopup,
  type DepositTopupCategory,
  type DepositTopupStatus,
} from "@/types";
import { CheckAccountingNoteButton } from "@/components/accounting/check-accounting-note-button";

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

const CATEGORY_OPTIONS: DepositTopupCategory[] = ["seat_expansion", "risk_buffer", "customer_requested", "renewal_escalation", "other"];

export function ContractDepositTopupsSection({ contractId, currentUserRole, depositShortfall, onShortfallCollected }: Props) {
  const [items, setItems] = useState<DepositTopup[]>([]);
  const [loading, setLoading] = useState(true);
  const [collectOpen, setCollectOpen] = useState(false);
  const [reverseOpen, setReverseOpen] = useState<DepositTopup | null>(null);
  const [cancelOpen, setCancelOpen] = useState<DepositTopup | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Collect dialog form state
  const [method, setMethod] = useState<"razorpay_link" | "manual">("razorpay_link");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<DepositTopupCategory>("customer_requested");
  const [categoryNote, setCategoryNote] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  const [appliesToShortfall, setAppliesToShortfall] = useState(false);
  const [paymentMode, setPaymentMode] = useState("bank_transfer");
  const [paymentReference, setPaymentReference] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);

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
    setMethod("razorpay_link");
    setAmount(prefillShortfall ? String(depositShortfall ?? "") : "");
    setCategory(prefillShortfall ? "renewal_escalation" : "customer_requested");
    setCategoryNote("");
    setCustomerMessage("");
    setAppliesToShortfall(prefillShortfall);
    setPaymentMode("bank_transfer");
    setPaymentReference("");
    setProofFile(null);
    setCollectOpen(true);
  }

  async function handleCollect() {
    const amt = Number(amount);
    if (!amt || amt <= 0) { toast.error("Amount must be positive"); return; }
    if (categoryNote.trim().length < 10) {
      toast.error("Add an internal note (at least 10 characters) so accounts can book this correctly");
      return;
    }

    setSubmitting(true);
    try {
      if (method === "razorpay_link") {
        const res = await fetch(`/api/contracts/${contractId}/deposit-topup/link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: amt, category, category_note: categoryNote.trim() || undefined,
            applies_to_shortfall: appliesToShortfall,
            customer_message: customerMessage.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) { toast.error(data.error ?? "Failed to send payment link"); return; }
        toast.success("Payment link sent to the customer");
      } else {
        if (!paymentMode) { toast.error("Payment mode is required"); return; }
        const form = new FormData();
        form.set("amount", String(amt));
        form.set("category", category);
        if (categoryNote.trim()) form.set("category_note", categoryNote.trim());
        form.set("payment_mode", paymentMode);
        if (paymentReference.trim()) form.set("payment_reference", paymentReference.trim());
        form.set("applies_to_shortfall", String(appliesToShortfall));
        if (proofFile) form.set("proof", proofFile);

        const res = await fetch(`/api/contracts/${contractId}/deposit-topup/manual`, { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) { toast.error(data.error ?? "Failed to record top-up"); return; }
        toast.success("Additional deposit recorded");
      }
      setCollectOpen(false);
      await load();
      if (appliesToShortfall) onShortfallCollected?.();
    } finally {
      setSubmitting(false);
    }
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
      <Dialog open={collectOpen} onOpenChange={(v) => { if (!v) setCollectOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Collect Additional Deposit</DialogTitle>
            <DialogDescription>
              No approval is required — this takes effect as soon as payment is confirmed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant={method === "razorpay_link" ? "default" : "outline"}
                size="sm"
                onClick={() => setMethod("razorpay_link")}
              >
                <Link2 className="h-3.5 w-3.5 mr-1.5" /> Send Payment Link
              </Button>
              <Button
                type="button"
                variant={method === "manual" ? "default" : "outline"}
                size="sm"
                onClick={() => setMethod("manual")}
              >
                <Banknote className="h-3.5 w-3.5 mr-1.5" /> Record Manually
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label>Amount (₹)</Label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 15000" />
            </div>

            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as DepositTopupCategory)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>{DEPOSIT_TOPUP_CATEGORY_LABELS[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>
                Internal Note (for Accounts) <span className="text-destructive">*</span>
              </Label>
              <Textarea
                value={categoryNote}
                onChange={(e) => setCategoryNote(e.target.value)}
                rows={2}
                placeholder="Why this additional deposit exists — never shown to the customer"
              />
              <CheckAccountingNoteButton
                note={categoryNote}
                accountingHead="Security Deposit"
                context={`Additional deposit — ${DEPOSIT_TOPUP_CATEGORY_LABELS[category]}`}
              />
            </div>

            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={appliesToShortfall}
                onChange={(e) => setAppliesToShortfall(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              This collects toward the renewal escalation shortfall
            </label>

            {method === "manual" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Payment Mode</Label>
                    <Select value={paymentMode} onValueChange={setPaymentMode}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                        <SelectItem value="neft">NEFT</SelectItem>
                        <SelectItem value="rtgs">RTGS</SelectItem>
                        <SelectItem value="upi">UPI</SelectItem>
                        <SelectItem value="cheque">Cheque</SelectItem>
                        <SelectItem value="cash">Cash</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Reference / UTR</Label>
                    <Input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="optional" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Proof of payment (optional)</Label>
                  <Input type="file" accept="image/*,.pdf" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} />
                </div>
              </>
            )}

            {method === "razorpay_link" && (
              <>
                <p className="text-xs text-muted-foreground">
                  A secure Razorpay payment link will be emailed to the customer immediately.
                </p>
                <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2.5">
                  <Label className="text-primary">
                    Message to Customer <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    value={customerMessage}
                    onChange={(e) => setCustomerMessage(e.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder="e.g. This covers the extra seat added from 24 Jun"
                  />
                  <p className="text-xs text-muted-foreground">Shown to the customer in the email, right below the greeting.</p>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCollectOpen(false)}>Cancel</Button>
            <Button onClick={handleCollect} disabled={submitting || !amount || categoryNote.trim().length < 10}>
              {submitting ? "Submitting…" : method === "razorpay_link" ? "Send Link" : "Record Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

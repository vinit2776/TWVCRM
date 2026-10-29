"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DEPOSIT_REFUND_STATUS_COLORS, DEPOSIT_REFUND_STATUS_LABELS, type DepositRefundStatus } from "@/lib/deposit-refund";
import { formatCurrency, formatDate } from "@/lib/utils";

export interface DepositRefund {
  id: string;
  amount: number | string;
  status: DepositRefundStatus;
  reason: string;
  reject_reason?: string | null;
  requested_at: string;
  approved_at?: string | null;
  paid_at?: string | null;
  payment_date?: string | null;
  payment_reference?: string | null;
}

/**
 * Walk-away refund on the proposal: ask for it, and see where it stands (awaiting
 * admin, to pay, refunded with date and UTR). Approval and payment happen in Acc Payables.
 */
export function DepositRefundSection({ proposalId, refund, canRequest, paidSoFar, onChanged }: {
  proposalId: string; refund: DepositRefund | null; canRequest: boolean; paidSoFar: number; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankNumber, setBankNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [saving, setSaving] = useState(false);

  const live = refund && refund.status !== "rejected";

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/deposit-refund`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, bank_account_name: bankName, bank_account_number: bankNumber, bank_ifsc: ifsc }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not request the refund"); return; }
      toast.success("Refund sent to an admin for approval");
      setOpen(false); setReason("");
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  if (!live && !(canRequest && paidSoFar > 0)) return null;

  return (
    <div className="rounded-md border border-red-200 bg-red-50/60 px-2.5 py-2 text-xs" data-testid="deposit-refund-section">
      {live && refund ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Customer withdrew · refund {formatCurrency(Number(refund.amount))}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${DEPOSIT_REFUND_STATUS_COLORS[refund.status]}`}>
              {DEPOSIT_REFUND_STATUS_LABELS[refund.status]}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Requested {formatDate(refund.requested_at)}
            {refund.status === "paid" && refund.payment_date ? ` · refunded ${formatDate(refund.payment_date)}` : ""}
            {refund.status === "paid" && refund.payment_reference ? ` · UTR ${refund.payment_reference}` : ""}
          </p>
          <p className="mt-0.5 text-[11px] italic text-muted-foreground">{refund.reason}</p>
          {refund.status !== "paid" && <p className="mt-1 text-[11px]">An admin approves it and accounts pays it from Acc Payables. Nothing is retained.</p>}
        </>
      ) : (
        <>
          <p className="text-[11px] text-red-900">Customer not going ahead? The {formatCurrency(paidSoFar)} paid so far is refunded in full — an admin approves it and accounts pays it.</p>
          <Button type="button" size="sm" variant="outline" className="mt-1.5 h-6 px-2 text-[11px] text-red-700" onClick={() => setOpen(true)}>
            <Undo2 className="mr-1 h-3 w-3" /> Customer walked away — refund
          </Button>
        </>
      )}

      <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) setOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Refund {formatCurrency(paidSoFar)} to the customer</DialogTitle>
            <DialogDescription>
              All of what was paid is refunded — nothing is retained. Once accounts pays it the proposal closes as &ldquo;Customer withdrew&rdquo;.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rf-reason">Why is the customer withdrawing? (min 10 characters)</Label>
              <Textarea id="rf-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label htmlFor="rf-bn">Account holder (optional)</Label><Input id="rf-bn" value={bankName} onChange={(e) => setBankName(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="rf-ba">Account number (optional)</Label><Input id="rf-ba" value={bankNumber} onChange={(e) => setBankNumber(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="rf-if">IFSC (optional)</Label><Input id="rf-if" value={ifsc} onChange={(e) => setIfsc(e.target.value)} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Close</Button>
            <Button variant="destructive" onClick={submit} disabled={saving || reason.trim().length < 10}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Send for approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

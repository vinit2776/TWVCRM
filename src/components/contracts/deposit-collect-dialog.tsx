"use client";

/**
 * DepositCollectDialog — the "collect an additional deposit / shortfall
 * top-up" flow, extracted out of ContractDepositTopupsSection so it can be
 * opened from anywhere a shortfall is visible (the contract page's own
 * Top-ups section, and the lead-level consolidated deposit summary) without
 * duplicating the razorpay-link/manual-record logic in two places.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link2, Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { DEPOSIT_TOPUP_CATEGORY_LABELS, type DepositTopupCategory } from "@/types";
import { CheckAccountingNoteButton } from "@/components/accounting/check-accounting-note-button";

const CATEGORY_OPTIONS: DepositTopupCategory[] = ["seat_expansion", "risk_buffer", "customer_requested", "renewal_escalation", "other"];

interface Props {
  contractId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fills amount/category for a renewal-escalation shortfall and pre-checks "applies to shortfall". */
  prefillShortfall?: number | null;
  onCollected: () => void;
}

export function DepositCollectDialog({ contractId, open, onOpenChange, prefillShortfall, onCollected }: Props) {
  const [method, setMethod] = useState<"razorpay_link" | "manual">("razorpay_link");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<DepositTopupCategory>("customer_requested");
  const [categoryNote, setCategoryNote] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  const [appliesToShortfall, setAppliesToShortfall] = useState(false);
  const [paymentMode, setPaymentMode] = useState("bank_transfer");
  const [paymentReference, setPaymentReference] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const isShortfall = Number(prefillShortfall || 0) > 0;
    setMethod("razorpay_link");
    setAmount(isShortfall ? String(prefillShortfall) : "");
    setCategory(isShortfall ? "renewal_escalation" : "customer_requested");
    setCategoryNote("");
    setCustomerMessage("");
    setAppliesToShortfall(isShortfall);
    setPaymentMode("bank_transfer");
    setPaymentReference("");
    setProofFile(null);
  }, [open, prefillShortfall]);

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
      onOpenChange(false);
      onCollected();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onOpenChange(false); }}>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleCollect} disabled={submitting || !amount || categoryNote.trim().length < 10}>
            {submitting ? "Submitting…" : method === "razorpay_link" ? "Send Link" : "Record Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

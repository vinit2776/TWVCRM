"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { TDS_CLIENT_SECTIONS } from "@/lib/constants";

/**
 * The one Record Payment dialog for billing statements — used by the Billing
 * page and the Receivables (AR) page. Posts to
 * POST /api/billing-statements/[id]/payment, including the TDS deduction
 * block (cash received + TDS deducted = invoice total). Don't hand-roll
 * per-page copies of this form: the AR page once had its own dialog and it
 * silently lacked TDS capture.
 */
interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statementId: string | null;
  /** Shown in the dialog title when provided. */
  statementNumber?: string | null;
  /** One-line party context (contract # · customer) shown under the title. */
  partyLabel?: string | null;
  balanceDue: number | null;
  /** Called after a payment is recorded successfully — refresh your lists here. */
  onSuccess: () => void;
}

const PAYMENT_MODES = [
  { value: "neft", label: "NEFT" },
  { value: "rtgs", label: "RTGS" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "upi", label: "UPI" },
  { value: "cheque", label: "Cheque" },
  { value: "cash", label: "Cash" },
  { value: "razorpay", label: "Razorpay (manually reconciled)" },
  { value: "other", label: "Other" },
];

export function RecordPaymentDialog({
  open, onOpenChange, statementId, statementNumber, partyLabel, balanceDue, onSuccess,
}: RecordPaymentDialogProps) {
  const [amount, setAmount]       = useState("");
  const [date, setDate]           = useState(new Date().toISOString().slice(0, 10));
  const [mode, setMode]           = useState("neft");
  const [reference, setReference] = useState("");
  const [notes, setNotes]         = useState("");
  const [submitting, setSubmitting] = useState(false);
  // TDS deduction on this payment (declared explicitly, never inferred).
  const [tdsEnabled, setTdsEnabled] = useState(false);
  const [tdsSection, setTdsSection] = useState("194I");
  const [tdsAmount, setTdsAmount]   = useState("");

  // Fresh form every time the dialog opens; prefill amount with the balance.
  useEffect(() => {
    if (open) {
      setAmount(balanceDue !== null && balanceDue > 0 ? String(balanceDue) : "");
      setDate(new Date().toISOString().slice(0, 10));
      setMode("neft");
      setReference("");
      setNotes("");
      setTdsEnabled(false);
      setTdsSection("194I");
      setTdsAmount("");
    }
  }, [open, balanceDue]);

  const handleSubmit = async () => {
    if (!statementId || !amount || Number(amount) <= 0) {
      toast.error("Amount must be positive");
      return;
    }
    const tdsAmt = tdsEnabled ? Math.max(0, Number(tdsAmount) || 0) : 0;
    if (tdsEnabled && tdsAmt <= 0) {
      toast.error("Enter the TDS amount deducted by the client");
      return;
    }
    if (tdsEnabled && !tdsSection) {
      toast.error("Select the TDS section");
      return;
    }
    setSubmitting(true);
    const res = await fetch(`/api/billing-statements/${statementId}/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Number(amount),
        payment_date: date,
        payment_mode: mode,
        payment_reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
        tds_amount:  tdsAmt,
        tds_section: tdsEnabled ? tdsSection : null,
      }),
    });
    setSubmitting(false);
    if (res.ok) {
      const json = await res.json();
      toast.success(
        `Payment recorded. ${json.payment_status === "paid"
          ? "Invoice fully paid!"
          : `Balance due: ₹${json.balance_due.toLocaleString("en-IN")}`}`
      );
      onOpenChange(false);
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to record payment");
    }
  };

  const cashNum = parseFloat(amount || "0");
  const tdsNum  = parseFloat(tdsAmount || "0");
  const settles = balanceDue !== null && Math.abs((cashNum + tdsNum) - balanceDue) < 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record Payment{statementNumber ? ` — ${statementNumber}` : ""}</DialogTitle>
          {partyLabel && (
            <p className="text-sm text-muted-foreground mt-1">{partyLabel}</p>
          )}
          {balanceDue !== null && balanceDue > 0 && (
            <p className="text-sm text-amber-700 font-medium mt-1">
              Balance due: {formatCurrency(balanceDue)}
            </p>
          )}
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Amount received (₹)</Label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 15000" />
            </div>
            <div className="space-y-2">
              <Label>Payment Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Payment Mode</Label>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Reference / UTR No.</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR or cheque number" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Additional notes…" rows={2} />
          </div>

          {/* ── TDS deduction block ──────────────────────────────────── */}
          <div className="rounded-lg border border-border">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-muted/30 rounded-lg transition-colors"
              onClick={() => { setTdsEnabled((v) => !v); if (!tdsEnabled) setTdsAmount(""); }}
            >
              <span className="flex items-center gap-2 font-medium">
                <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${tdsEnabled ? "bg-teal-600 border-teal-600 text-white" : "border-gray-400"}`}>
                  {tdsEnabled ? "✓" : ""}
                </span>
                Client deducted TDS on this payment
              </span>
              <span className="text-xs text-muted-foreground">TDS on income</span>
            </button>

            {tdsEnabled && (
              <div className="px-3 pb-3 pt-1 space-y-3 border-t">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">TDS section *</Label>
                    <Select value={tdsSection} onValueChange={setTdsSection}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TDS_CLIENT_SECTIONS.map((s) => (
                          <SelectItem key={s.code} value={s.code} className="text-xs">
                            <span className="font-mono font-medium">{s.label}</span>
                            <span className="text-muted-foreground ml-1.5">— {s.description}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">TDS amount (₹) *</Label>
                    <Input
                      type="number"
                      min={0.01}
                      step="any"
                      value={tdsAmount}
                      onChange={(e) => setTdsAmount(e.target.value)}
                      placeholder="e.g. 1500"
                      className="h-9 text-xs"
                    />
                  </div>
                </div>
                {/* Live settlement preview */}
                {tdsNum > 0 && (
                  <div className={`rounded px-2.5 py-1.5 text-xs font-medium ${
                    settles
                      ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                      : "bg-blue-50 text-blue-800 border border-blue-200"
                  }`}>
                    Cash {formatCurrency(cashNum)} + TDS {formatCurrency(tdsNum)}
                    {" = "}{formatCurrency(cashNum + tdsNum)}
                    {settles ? " ✓ settles invoice" : ""}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Invoice settles as: cash received + TDS deducted = invoice total. Tally receipt splits bank + TDS ledger + party.
                </p>
              </div>
            )}
          </div>

          <Button onClick={handleSubmit} disabled={submitting} className="w-full">
            {submitting ? "Recording…" : "Record Payment"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { STATEMENT_PAYMENT_MODES, TDS_CLIENT_SECTIONS } from "@/lib/constants";

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
  /**
   * Called after a payment is recorded successfully — refresh your lists here.
   *
   * `paymentId` is the billing_payments row that was just created, present
   * only on the straightforward cash/bank path. It is absent when the payment
   * went through the deposit-adjustment route, because that only *requests*
   * an adjustment and no payment exists yet. Callers that need to link to a
   * real payment (verifying a reported payment) must handle the undefined
   * case rather than assume one was created.
   */
  onSuccess: (paymentId?: string) => void;
  /**
   * Prefills the form. Used when verifying a reported payment, so accounts
   * confirm what ops were told rather than retyping it from the thread.
   */
  prefill?: {
    amount?: number | null;
    date?: string | null;
    mode?: string | null;
    reference?: string | null;
  } | null;
}

const PAYMENT_MODES = STATEMENT_PAYMENT_MODES;

export function RecordPaymentDialog({
  open, onOpenChange, statementId, statementNumber, partyLabel, balanceDue, onSuccess, prefill,
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

  // Adjustment against deposit — available balance gates whether the mode
  // is offered at all; a request over that balance splits the remainder
  // into a normal payment on the secondary leg below.
  const [depositAvailable, setDepositAvailable] = useState<number | null>(null);
  const [notifyCustomer, setNotifyCustomer] = useState(false);
  const [remainderMode, setRemainderMode] = useState("neft");
  const [remainderReference, setRemainderReference] = useState("");

  // Fresh form every time the dialog opens. Defaults to the balance due and
  // today; `prefill` overrides field by field when the caller already knows
  // what the payment was — verifying a reported payment, where retyping the
  // amount the reporter supplied is how transcription errors get in.
  useEffect(() => {
    if (open) {
      const prefilledAmount = prefill?.amount != null && prefill.amount > 0 ? prefill.amount : null;
      setAmount(
        prefilledAmount !== null
          ? String(prefilledAmount)
          : balanceDue !== null && balanceDue > 0
            ? String(balanceDue)
            : "",
      );
      setDate(prefill?.date || new Date().toISOString().slice(0, 10));
      setMode(prefill?.mode || "neft");
      setReference(prefill?.reference || "");
      setNotes("");
      setTdsEnabled(false);
      setTdsSection("194I");
      setTdsAmount("");
      setNotifyCustomer(false);
      setRemainderMode("neft");
      setRemainderReference("");
      setDepositAvailable(null);
    }
  }, [open, balanceDue, prefill]);

  useEffect(() => {
    if (!open || !statementId) return;
    fetch(`/api/billing-statements/${statementId}/deposit-balance`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setDepositAvailable(json?.data?.available ?? 0))
      .catch(() => setDepositAvailable(0));
  }, [open, statementId]);

  const isDepositMode = mode === "deposit_adjustment";
  const requestedAmount = parseFloat(amount || "0");
  const depositLeg = isDepositMode ? Math.min(requestedAmount, depositAvailable ?? 0) : 0;
  const remainderLeg = isDepositMode ? Math.max(0, requestedAmount - (depositAvailable ?? 0)) : 0;

  const handleDepositSubmit = async () => {
    if (!statementId || depositLeg <= 0) {
      toast.error("Amount must be positive");
      return;
    }
    if (remainderLeg > 0 && !remainderMode) {
      toast.error("Select a payment mode for the remainder");
      return;
    }
    setSubmitting(true);
    // Deposit leg first — it's the conditional one (subject to approval and
    // balance validation). If it fails, nothing else happens. If it
    // succeeds but the remainder leg fails, the request is still safely
    // recorded and the remainder can be added separately — better than the
    // reverse order, where a real cash payment could land with no
    // corresponding approval request to notice was missing.
    const depositRes = await fetch(`/api/billing-statements/${statementId}/deposit-adjustment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: depositLeg, notify_customer: notifyCustomer }),
    });
    if (!depositRes.ok) {
      setSubmitting(false);
      const err = await depositRes.json().catch(() => null);
      toast.error(err?.error || "Failed to submit deposit adjustment request");
      return;
    }

    if (remainderLeg > 0) {
      const remainderRes = await fetch(`/api/billing-statements/${statementId}/payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: remainderLeg,
          payment_date: date,
          payment_mode: remainderMode,
          payment_reference: remainderReference.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      setSubmitting(false);
      if (!remainderRes.ok) {
        const err = await remainderRes.json().catch(() => null);
        toast.error(
          `Deposit adjustment of ${formatCurrency(depositLeg)} submitted for approval, but recording the ` +
          `${formatCurrency(remainderLeg)} remainder failed: ${err?.error || "unknown error"}. Record it separately.`
        );
        onOpenChange(false);
        onSuccess();
        return;
      }
      toast.success(
        `${formatCurrency(depositLeg)} submitted for approval as a deposit adjustment. ` +
        `${formatCurrency(remainderLeg)} recorded via ${remainderMode}.`
      );
    } else {
      setSubmitting(false);
      toast.success(`${formatCurrency(depositLeg)} submitted for admin/manager approval as a deposit adjustment.`);
    }
    onOpenChange(false);
    onSuccess();
  };

  const handleSubmit = async () => {
    if (!statementId || !amount || Number(amount) <= 0) {
      toast.error("Amount must be positive");
      return;
    }

    if (isDepositMode) {
      await handleDepositSubmit();
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
      const recordedPaymentId: string | undefined = json?.data?.id;
      toast.success(
        `Payment recorded. ${json.payment_status === "paid"
          ? "Invoice fully paid!"
          : `Balance due: ₹${json.balance_due.toLocaleString("en-IN")}`}`
      );
      onOpenChange(false);
      onSuccess(recordedPaymentId);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to record payment");
    }
  };

  const cashNum = parseFloat(amount || "0");
  const tdsNum  = parseFloat(tdsAmount || "0");
  const settles = balanceDue !== null && Math.abs((cashNum + tdsNum) - balanceDue) < 1;

  const availableModes = (depositAvailable ?? 0) > 0
    ? [...PAYMENT_MODES, { value: "deposit_adjustment", label: "Adjustment against deposit" }]
    : PAYMENT_MODES;

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
              <Label>{isDepositMode ? "Amount to settle (₹)" : "Amount received (₹)"}</Label>
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
                  {availableModes.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!isDepositMode && (
              <div className="space-y-2">
                <Label>Reference / UTR No.</Label>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR or cheque number" />
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Additional notes…" rows={2} />
          </div>

          {/* ── Adjustment against deposit block ────────────────────── */}
          {isDepositMode && (
            <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Available deposit balance (all contracts for this customer): <span className="font-semibold text-foreground">{formatCurrency(depositAvailable ?? 0)}</span>
              </p>
              <div className="rounded px-2.5 py-1.5 text-xs font-medium bg-white border border-teal-200">
                {formatCurrency(depositLeg)} from deposit
                {remainderLeg > 0 && <> + {formatCurrency(remainderLeg)} via another mode</>}
                {" = "}{formatCurrency(depositLeg + remainderLeg)}
              </div>
              {remainderLeg > 0 && (
                <div className="grid grid-cols-2 gap-3 pt-1 border-t border-teal-200">
                  <div className="space-y-1">
                    <Label className="text-xs">Remainder payment mode</Label>
                    <Select value={remainderMode} onValueChange={setRemainderMode}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PAYMENT_MODES.map((m) => (
                          <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Remainder reference</Label>
                    <Input
                      value={remainderReference}
                      onChange={(e) => setRemainderReference(e.target.value)}
                      placeholder="UTR or cheque number"
                      className="h-9 text-xs"
                    />
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox checked={notifyCustomer} onCheckedChange={(v) => setNotifyCustomer(v === true)} />
                Email the customer a confirmation of this adjustment
              </label>
              <p className="text-[11px] text-muted-foreground">
                This requires admin or manager approval before it settles — the deposit portion won&apos;t reduce the
                balance due until approved.
              </p>
            </div>
          )}

          {/* ── TDS deduction block ──────────────────────────────────── */}
          {!isDepositMode && (
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
          )}

          <Button onClick={handleSubmit} disabled={submitting} className="w-full">
            {submitting
              ? (isDepositMode ? "Submitting…" : "Recording…")
              : (isDepositMode ? "Submit for Approval" : "Record Payment")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

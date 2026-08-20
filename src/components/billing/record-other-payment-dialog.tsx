"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";

/**
 * The one Record Payment dialog for receivables that don't live in
 * billing_statements — security deposits, deposit top-ups and ad-hoc
 * invoices. Each posts to its own endpoint; the form around them is the same.
 *
 * Extracted from the Receivables page so verifying a *reported* deposit can
 * reuse it (see PaymentReportCard) instead of growing a second deposit form.
 * The billing side already learned this the hard way: the AR page once had
 * its own statement payment form and it silently lacked TDS capture.
 */

export interface OtherReceivableRow {
  id: string;
  kind: "deposit" | "topup" | "adhoc_invoice";
  reference: string;
  party_name: string;
  total_amount: number;
  balance_due: number;
  due_date: string | null;
  days_overdue: number | null;
  payment_link_url: string | null;
  is_stale: boolean;
  followup_enabled: boolean;
  reminder_count: number;
  href: string | null;
  parent_id?: string | null;
}

export const OTHER_KIND_STYLE: Record<OtherReceivableRow["kind"], { label: string; cls: string }> = {
  deposit: { label: "Security deposit", cls: "border-violet-300 bg-violet-50 text-violet-700" },
  topup: { label: "Deposit top-up", cls: "border-purple-300 bg-purple-50 text-purple-700" },
  adhoc_invoice: { label: "Ad-hoc invoice", cls: "border-sky-300 bg-sky-50 text-sky-700" },
};

const PAYMENT_MODES = ["bank_transfer", "upi", "cheque", "cash", "card", "other"];

export function RecordOtherPaymentDialog({ row, onClose, onDone }: {
  row: OtherReceivableRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(row.balance_due));
  const [mode, setMode] = useState("bank_transfer");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [shortfallApproved, setShortfallApproved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const kindLabel = OTHER_KIND_STYLE[row.kind].label;
  // A deposit recorded below the required amount needs explicit sign-off
  // (and the server rejects anything more than 10% short outright).
  const shortfall = row.balance_due - (parseFloat(amount) || 0);
  const needsShortfallApproval = row.kind === "deposit" && shortfall > 0;
  // The top-up settle endpoint closes out a fixed pending amount, so the
  // figure isn't the operator's to change there.
  const amountEditable = row.kind !== "topup";

  async function submit() {
    const amt = parseFloat(amount);
    if (amountEditable && (!amt || amt <= 0)) {
      toast.error("Enter a valid amount");
      return;
    }
    setSubmitting(true);
    try {
      let res: Response;
      if (row.kind === "deposit") {
        const fd = new FormData();
        fd.append("amount", String(amt));
        fd.append("payment_medium", mode);
        if (reference) fd.append("reference", reference);
        if (notes) fd.append("notes", notes);
        if (proof) fd.append("payment_proof", proof);
        if (shortfallApproved) fd.append("shortfall_approved", "true");
        res = await fetch(`/api/proposals/${row.id}/deposit-payment`, { method: "POST", body: fd });
      } else if (row.kind === "topup") {
        if (!row.parent_id) throw new Error("Top-up is missing its contract reference");
        const fd = new FormData();
        fd.append("payment_mode", mode);
        if (reference) fd.append("payment_reference", reference);
        if (proof) fd.append("proof", proof);
        res = await fetch(
          `/api/contracts/${row.parent_id}/deposit-topup/${row.id}/record-payment`,
          { method: "POST", body: fd },
        );
      } else {
        res = await fetch(`/api/invoices/${row.id}/payment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: amt, reference, notes }),
        });
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not record the payment");
      toast.success("Payment recorded");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the payment");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment — {row.reference}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {kindLabel} · {row.party_name} · outstanding {formatCurrency(row.balance_due)}
          </p>

          <div>
            <Label>Amount received</Label>
            <Input
              type="number"
              value={amount}
              disabled={!amountEditable}
              onChange={(e) => setAmount(e.target.value)}
            />
            {!amountEditable && (
              <p className="text-xs text-muted-foreground mt-1">
                A top-up settles for its full pending amount.
              </p>
            )}
          </div>

          <div>
            <Label>Payment mode</Label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="w-full border rounded-md h-9 px-2 text-sm"
            >
              {PAYMENT_MODES.map((m) => (
                <option key={m} value={m}>{m.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>

          <div>
            <Label>Reference / UTR</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="optional" />
          </div>

          {row.kind !== "topup" && (
            <div>
              <Label>Notes</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
            </div>
          )}

          {needsShortfallApproval && (
            <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
              <input
                type="checkbox"
                checked={shortfallApproved}
                onChange={(e) => setShortfallApproved(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Approve a shortfall of {formatCurrency(shortfall)} against the required deposit.
                Admin or manager only; anything more than 10% short is rejected.
              </span>
            </label>
          )}

          {row.kind !== "adhoc_invoice" && (
            <div>
              <Label>Payment proof (optional)</Label>
              <input
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => setProof(e.target.files?.[0] || null)}
                className="block w-full text-sm border rounded-md p-2"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

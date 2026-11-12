"use client";

import { useState } from "react";
import { Loader2, Lock, Settings2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, formatDate } from "@/lib/utils";

type Payment = {
  id: string;
  amount: number;
  payment_mode: string;
  payment_reference: string | null;
  payment_date: string;
  reversed_at?: string | null;
  petty_cash_book_id?: string | null;
};

type Props = {
  billId: string;
  billNumber: string;
  approvalStatus: string;
  payments: Payment[];
  /** The cheque for this bill has been marked signed. */
  chequeSigned?: boolean;
  /** The procurement cycle is closed — corrections are disabled until an admin reopens it. */
  locked?: boolean;
  isAdmin: boolean;
  onDone: () => void;
};

type Mode = "reverse_payment" | "unapprove" | "withdraw" | "unsign_cheque" | null;

const MIN_REASON = 10;

// Admin-only "Correct" menu for a vendor bill. Each action undoes ONE step —
// a bill with standing payments must have them reversed before it can be
// un-approved. Server enforces the same rules; the disabled states here just
// explain them up front.
export function BillCorrectMenu({ billId, billNumber, approvalStatus, payments, chequeSigned, locked, isAdmin, onDone }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [paymentId, setPaymentId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!isAdmin) return null;
  if (locked) {
    return (
      <Button size="sm" variant="outline" className="gap-1.5" disabled title="This procurement cycle is closed. Reopen it first.">
        <Lock className="h-3.5 w-3.5" /> Correct
      </Button>
    );
  }

  const standing = payments
    .filter((p) => !p.reversed_at)
    .sort((a, b) => new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime());
  const canReversePayment = standing.length > 0;
  const canUnapprove = approvalStatus === "approved" && standing.length === 0;
  const canWithdraw = approvalStatus === "pending" || approvalStatus === "rejected";
  if (!canReversePayment && !canUnapprove && !canWithdraw && !chequeSigned && approvalStatus !== "approved") return null;

  const selected = standing.find((p) => p.id === paymentId) ?? standing[0];

  const open = (m: Exclude<Mode, null>) => {
    setReason("");
    setPaymentId(standing[0]?.id ?? "");
    setMode(m);
  };

  const submit = async () => {
    if (reason.trim().length < MIN_REASON) {
      toast.error(`Give a reason of at least ${MIN_REASON} characters — it is saved to the audit trail`);
      return;
    }
    setSubmitting(true);
    try {
      const res =
        mode === "reverse_payment"
          ? await fetch(`/api/procurement/bills/${billId}/payments/${selected.id}/reverse`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason: reason.trim() }),
            })
          : await fetch(`/api/procurement/bills/${billId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: mode, reason: reason.trim() }),
            });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Could not complete the rollback");
        return;
      }
      toast.success(
        mode === "reverse_payment" ? "Payment reversed"
        : mode === "withdraw" ? `${billNumber} withdrawn`
        : mode === "unsign_cheque" ? "Cheque signature removed"
        : `${billNumber} returned to approval`
      );
      setMode(null);
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" /> Correct
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Admin — undo one step
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canReversePayment} onSelect={() => open("reverse_payment")}>
            <Undo2 className="h-3.5 w-3.5 mr-2" /> Reverse a payment…
          </DropdownMenuItem>
          {approvalStatus === "approved" && (
            <DropdownMenuItem disabled={!canUnapprove} onSelect={() => open("unapprove")}>
              <Undo2 className="h-3.5 w-3.5 mr-2" /> Un-approve bill…
            </DropdownMenuItem>
          )}
          {chequeSigned && (
            <DropdownMenuItem onSelect={() => open("unsign_cheque")}>
              <Undo2 className="h-3.5 w-3.5 mr-2" /> Un-sign cheque…
            </DropdownMenuItem>
          )}
          {canWithdraw && (
            <DropdownMenuItem onSelect={() => open("withdraw")}>
              <Undo2 className="h-3.5 w-3.5 mr-2" /> Withdraw bill…
            </DropdownMenuItem>
          )}
          {approvalStatus === "approved" && !canUnapprove && (
            <p className="px-2 pb-1.5 text-xs text-muted-foreground">
              Reverse the payments first, then un-approve. A bill can be withdrawn once it is back to pending.
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={mode !== null} onOpenChange={(o) => !o && !submitting && setMode(null)}>
        <DialogContent className="max-w-md">
          {mode === "reverse_payment" && selected && (
            <>
              <DialogHeader>
                <DialogTitle>Reverse payment — {billNumber}</DialogTitle>
                <DialogDescription>
                  The payment stays in history, marked reversed. Nothing is deleted.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="rb-payment">Payment</Label>
                  <Select value={selected.id} onValueChange={setPaymentId}>
                    <SelectTrigger id="rb-payment"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {standing.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {formatCurrency(p.amount)} · {formatDate(p.payment_date)} · {p.payment_mode.replace(/_/g, " ")}
                          {p.payment_reference ? ` · ${p.payment_reference}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium mb-1">This will:</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                    <li>Take {formatCurrency(selected.amount)} off the amount paid; the bill&apos;s payment status is recomputed</li>
                    <li>Reverse any TDS deducted on this payment (blocked if it is already on a challan)</li>
                    {selected.payment_mode === "cash" && selected.petty_cash_book_id && (
                      <li>Credit {formatCurrency(selected.amount)} back to the petty cash book it was paid from</li>
                    )}
                    {selected.payment_mode === "cheque" && (
                      <li>Void the cheque signature if no other cheque payment stands</li>
                    )}
                  </ul>
                </div>
                <ReasonField value={reason} onChange={setReason} />
              </div>
            </>
          )}

          {mode === "unapprove" && (
            <>
              <DialogHeader>
                <DialogTitle>Un-approve — {billNumber}</DialogTitle>
                <DialogDescription>
                  The bill goes back to the approval queue as pending.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium mb-1">This will:</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                    <li>Clear the approval, approval code and payment batch</li>
                    <li>Lift any payment hold</li>
                    <li>Return a linked goods PO from Invoice Approved to Invoice Received</li>
                    <li>Keep the GST figure already entered</li>
                  </ul>
                </div>
                <ReasonField value={reason} onChange={setReason} />
              </div>
            </>
          )}

          {mode === "unsign_cheque" && (
            <>
              <DialogHeader>
                <DialogTitle>Un-sign cheque — {billNumber}</DialogTitle>
                <DialogDescription>
                  Use this when the cheque was marked signed by mistake.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium mb-1">This will:</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                    <li>Clear the signature so the cheque shows as awaiting signature again</li>
                    <li>Clear it on every bill that was signed together with this one (same cheque)</li>
                    <li>Leave the payment itself as it is</li>
                  </ul>
                </div>
                <ReasonField value={reason} onChange={setReason} />
              </div>
            </>
          )}

          {mode === "withdraw" && (
            <>
              <DialogHeader>
                <DialogTitle>Withdraw — {billNumber}</DialogTitle>
                <DialogDescription>
                  Use this for a bill uploaded against the wrong PO, or twice. It stays in history marked Withdrawn.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium mb-1">This will:</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                    <li>Take the bill out of every queue, total and duplicate check</li>
                    <li>Return a linked goods PO to the status it had before this invoice (e.g. Received)</li>
                    <li>Free the invoice number and the PO value so the right bill can be uploaded</li>
                    <li>Lock this bill — it can&apos;t be edited or revived afterwards</li>
                  </ul>
                </div>
                <ReasonField value={reason} onChange={setReason} />
              </div>
            </>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)} disabled={submitting}>Cancel</Button>
            <Button variant="destructive" onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {mode === "reverse_payment" ? "Reverse payment" : mode === "withdraw" ? "Withdraw bill" : mode === "unsign_cheque" ? "Un-sign cheque" : "Un-approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="rb-reason">
        Reason <span className="text-red-500">*</span>
      </Label>
      <Textarea
        id="rb-reason"
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Paid against the wrong bill — saved to the audit trail"
      />
    </div>
  );
}

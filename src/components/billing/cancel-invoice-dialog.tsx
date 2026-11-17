"use client";

import { useState } from "react";
import { Ban, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface CancelInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statementId: string;
  statementNumber: string;
  customerName: string;
  amountLabel: string;
  hasPaymentLink: boolean;
  /** pi = cancel now; gst = ask Accounts to issue a credit note. */
  kind: "pi" | "gst";
  onSuccess: () => void;
}

export function CancelInvoiceDialog({
  open, onOpenChange, statementId, statementNumber, customerName, amountLabel, hasPaymentLink, kind, onSuccess,
}: CancelInvoiceDialogProps) {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const reasonValid = reason.trim().length >= 10;

  async function handleConfirm() {
    setLoading(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) {
        toast.error(json.error || "Failed to cancel the invoice");
        return;
      }
      toast.success(
        kind === "gst"
          ? `Cancellation requested. Reminders have stopped and Accounts has a credit note to issue.`
          : `${statementNumber} cancelled. Reminders have stopped.`,
      );
      onOpenChange(false);
      setReason("");
      onSuccess();
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!loading) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <Ban className="h-5 w-5 shrink-0" /> {kind === "gst" ? "Request cancellation of" : "Cancel"} {statementNumber}?
          </DialogTitle>
          <DialogDescription>{customerName} · {amountLabel}</DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
          <div className="flex items-start gap-2"><X className="h-4 w-4 text-destructive mt-0.5 shrink-0" /><span>Payment reminders stop right away</span></div>
          {hasPaymentLink && (
            <div className="flex items-start gap-2"><X className="h-4 w-4 text-destructive mt-0.5 shrink-0" /><span>The payment link is cancelled</span></div>
          )}
          {kind === "gst" ? (
            <>
              <div className="flex items-start gap-2"><X className="h-4 w-4 text-destructive mt-0.5 shrink-0" /><span>Accounts gets a task in the <b>Tally Inbox</b> to issue a credit note and cancel the GST invoice</span></div>
              <div className="flex items-start gap-2"><X className="h-4 w-4 text-destructive mt-0.5 shrink-0" /><span>The invoice stays on Receivables as <b>Cancellation requested</b> until the credit note is uploaded</span></div>
              <p className="text-xs text-amber-700 pt-1">A GST invoice is a legal document. It is not cancelled until Accounts uploads the credit note. Nothing is sent to the customer.</p>
            </>
          ) : (
            <>
              <div className="flex items-start gap-2"><X className="h-4 w-4 text-destructive mt-0.5 shrink-0" /><span>The proforma is marked cancelled and leaves Receivables</span></div>
              <p className="text-xs text-muted-foreground pt-1">Nothing is sent to the customer. No Tally action is needed for a proforma.</p>
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cancel-reason">Reason</Label>
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer changed plan before signing"
            rows={3}
          />
          <p className="text-xs text-muted-foreground">At least 10 characters. Saved in the audit trail.</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>Keep invoice</Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={!reasonValid || loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />} {kind === "gst" ? "Request cancellation" : "Cancel invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

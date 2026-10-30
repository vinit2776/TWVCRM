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
  onSuccess: () => void;
}

export function CancelInvoiceDialog({
  open, onOpenChange, statementId, statementNumber, customerName, amountLabel, hasPaymentLink, onSuccess,
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
      toast.success(`${statementNumber} cancelled. Reminders have stopped.`);
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
            <Ban className="h-5 w-5 shrink-0" /> Cancel {statementNumber}?
          </DialogTitle>
          <DialogDescription>{customerName} · {amountLabel}</DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
          <div className="flex items-start gap-2"><X className="h-4 w-4 text-destructive mt-0.5 shrink-0" /><span>Payment reminders stop right away</span></div>
          {hasPaymentLink && (
            <div className="flex items-start gap-2"><X className="h-4 w-4 text-destructive mt-0.5 shrink-0" /><span>The payment link is cancelled</span></div>
          )}
          <div className="flex items-start gap-2"><X className="h-4 w-4 text-destructive mt-0.5 shrink-0" /><span>The proforma is marked cancelled and leaves Receivables</span></div>
          <p className="text-xs text-muted-foreground pt-1">Nothing is sent to the customer. No Tally action is needed for a proforma.</p>
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
            {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Cancel invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

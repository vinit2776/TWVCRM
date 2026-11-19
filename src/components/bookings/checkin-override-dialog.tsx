"use client";

/**
 * CheckinOverrideDialog — admin/manager check-in with the balance still due.
 *
 * Exists so staff never need to record a fake cash payment just to get a
 * walk-in past the payment gate. The reason is mandatory, sent to
 * PATCH /api/bookings/[id] as `payment_override_reason`, and audit-logged
 * server-side. The balance stays outstanding and is chased at checkout.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

const MIN_REASON_LENGTH = 10;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  balanceDue: number;
  onSuccess: () => void;
}

export function CheckinOverrideDialog({ open, onOpenChange, bookingId, balanceDue, onSuccess }: Props) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setError(`Enter a reason of at least ${MIN_REASON_LENGTH} characters`);
      return;
    }
    setSubmitting(true);
    const res = await fetch(`/api/bookings/${bookingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "checked_in", payment_override_reason: reason.trim() }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Couldn't check in. Try again.");
      return;
    }
    toast.success("Guest checked in with balance due");
    setReason("");
    setError(null);
    onOpenChange(false);
    onSuccess();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Check in with balance due</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {formatCurrency(balanceDue)} stays outstanding and will be flagged for collection at checkout. This is logged against your name.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="override-reason">Reason</Label>
            <Textarea
              id="override-reason"
              value={reason}
              onChange={(e) => { setReason(e.target.value); setError(null); }}
              placeholder="UPI is down, guest will pay at checkout"
              rows={3}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Check in
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

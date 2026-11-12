"use client";

/**
 * CorrectPaymentMethodDialog — fix a payment recorded under the wrong method
 * (e.g. cash entered for a UPI payment). Submits to
 * PATCH /api/booking-payments/[id]/method, which refuses once the GST invoice
 * has been uploaded in the Tally Inbox.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { BOOKING_PAYMENT_MODE_LABELS } from "@/lib/constants";

const MODES = ["cash", "upi", "card"] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: { id: string; amount: number; payment_mode: string; payment_reference?: string | null };
  onSuccess: () => void;
}

export function CorrectPaymentMethodDialog({ open, onOpenChange, payment, onSuccess }: Props) {
  const [mode, setMode] = useState<string>(payment.payment_mode);
  const [reference, setReference] = useState(payment.payment_reference ?? "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMode(payment.payment_mode);
      setReference(payment.payment_reference ?? "");
      setReason("");
    }
  }, [open, payment.payment_mode, payment.payment_reference]);

  const unchanged = mode === payment.payment_mode;
  const canSubmit = !unchanged && reason.trim().length >= 3 && !saving;

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch(`/api/booking-payments/${payment.id}/method`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payment_mode: mode,
          payment_reference: mode === "cash" ? null : reference.trim() || null,
          reason: reason.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Could not change the payment method");
        return;
      }
      toast.success("Payment method corrected");
      onOpenChange(false);
      onSuccess();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Correct payment method</DialogTitle>
          <DialogDescription>
            {formatCurrency(payment.amount)} was recorded as{" "}
            <strong>{BOOKING_PAYMENT_MODE_LABELS[payment.payment_mode] || payment.payment_mode}</strong>.
            You can change this until accounts issues the GST invoice.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Actual payment method</Label>
            <div className="grid grid-cols-3 gap-2">
              {MODES.map((m) => (
                <Button
                  key={m}
                  type="button"
                  variant={mode === m ? "default" : "outline"}
                  size="sm"
                  onClick={() => setMode(m)}
                >
                  {BOOKING_PAYMENT_MODE_LABELS[m]}
                </Button>
              ))}
            </div>
          </div>

          {mode !== "cash" && (
            <div className="space-y-1.5">
              <Label htmlFor="pm-ref">{mode === "upi" ? "UPI reference / UTR" : "Card reference"} (optional)</Label>
              <Input id="pm-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="pm-reason">Reason for correction</Label>
            <Textarea
              id="pm-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Customer paid by UPI, entered as cash by mistake"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save correction
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

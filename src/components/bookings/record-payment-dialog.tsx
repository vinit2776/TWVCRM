"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, preventEnterSubmit } from "@/lib/utils";
import { PAYMENT_MODES, PAYMENT_MODE_LABELS } from "@/lib/constants";

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  amount: number;
  onSuccess: () => void;
}

export function RecordPaymentDialog({
  open,
  onOpenChange,
  bookingId,
  amount,
  onSuccess,
}: RecordPaymentDialogProps) {
  const [paymentMode, setPaymentMode] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentMode) {
      toast.error("Please select a payment mode");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payment_status: "paid",
          payment_mode: paymentMode,
          payment_reference: paymentReference.trim() || undefined,
        }),
      });

      if (res.ok) {
        toast.success("Payment recorded");
        onSuccess();
        onOpenChange(false);
        setPaymentMode("");
        setPaymentReference("");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to record payment");
      }
    } catch {
      toast.error("Failed to record payment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-4">
          <div className="rounded-md bg-muted/50 p-3 text-center">
            <p className="text-sm text-muted-foreground">Amount Due</p>
            <p className="text-2xl font-bold">{formatCurrency(amount)}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pay-mode">Payment Mode *</Label>
            <Select value={paymentMode} onValueChange={setPaymentMode}>
              <SelectTrigger id="pay-mode"><SelectValue placeholder="Select mode" /></SelectTrigger>
              <SelectContent>
                {PAYMENT_MODES.map(m => (
                  <SelectItem key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pay-ref">Payment Reference</Label>
            <Input
              id="pay-ref"
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder="UPI Ref / Transaction ID"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !paymentMode}>
              {saving ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Recording...</>
              ) : (
                "Confirm Payment"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

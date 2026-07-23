"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { ImproveWordingButton } from "@/components/billing/improve-wording-button";

interface EditableCharge {
  id: string;
  description: string;
  contract_id?: string | null;
  quantity: number;
  unit_price: number;
  gst_rate?: number;
  charge_date: string;
  notes?: string;
}

interface EditUsageChargeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  charge: EditableCharge | null;
}

export function EditUsageChargeDialog({
  open,
  onOpenChange,
  onSuccess,
  charge,
}: EditUsageChargeDialogProps) {
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState<number>(1);
  const [unitPrice, setUnitPrice] = useState<number>(0);
  const [gstRate, setGstRate] = useState<number>(18);
  const [chargeDate, setChargeDate] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Contract-linked charges keep GST locked to the contract's rate (set at
  // creation) so it can't drift from the billing statement — only
  // booking-based charges allow an editable GST rate.
  const gstLocked = !!charge?.contract_id;

  useEffect(() => {
    if (open && charge) {
      setDescription(charge.description);
      setQuantity(Number(charge.quantity));
      setUnitPrice(Number(charge.unit_price));
      setGstRate(Number(charge.gst_rate ?? 18));
      setChargeDate(charge.charge_date);
      setNotes(charge.notes || "");
    }
  }, [open, charge]);

  const subtotal = quantity * unitPrice;
  const gstAmount = parseFloat((subtotal * gstRate / 100).toFixed(2));
  const totalWithGst = parseFloat((subtotal + gstAmount).toFixed(2));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!charge) return;

    if (!description.trim()) {
      toast.error("Please enter a description");
      return;
    }
    if (quantity <= 0) {
      toast.error("Quantity must be greater than 0");
      return;
    }
    if (unitPrice <= 0) {
      toast.error("Unit price must be greater than 0");
      return;
    }
    if (!chargeDate) {
      toast.error("Please select a charge date");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/usage-charges/${charge.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          quantity,
          unit_price: unitPrice,
          total: subtotal,
          gst_rate: gstRate,
          charge_date: chargeDate,
          notes: notes.trim() || undefined,
        }),
      });

      if (res.ok) {
        toast.success("Charge updated");
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to update charge");
      }
    } catch {
      toast.error("Failed to update charge");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Charge</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-charge-description">
              Description <span className="text-destructive">*</span>
            </Label>
            <Input
              id="edit-charge-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <ImproveWordingButton description={description} onApply={setDescription} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-charge-quantity">
                Quantity <span className="text-destructive">*</span>
              </Label>
              <Input
                id="edit-charge-quantity"
                type="number"
                min={0.01}
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(parseFloat(e.target.value) || 0)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-charge-unit-price">
                Unit Price <span className="text-destructive">*</span>
              </Label>
              <Input
                id="edit-charge-unit-price"
                type="number"
                min={0.01}
                step="any"
                value={unitPrice}
                onChange={(e) => setUnitPrice(parseFloat(e.target.value) || 0)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Subtotal (ex-GST)</Label>
              <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-sm">
                {formatCurrency(subtotal)}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-charge-gst-rate" className="text-xs text-muted-foreground">
                GST %{gstLocked && " (contract rate)"}
              </Label>
              <Input
                id="edit-charge-gst-rate"
                type="number"
                min={0}
                max={28}
                step="0.01"
                value={gstRate}
                onChange={(e) => setGstRate(parseFloat(e.target.value) || 0)}
                className="h-9"
                disabled={gstLocked}
                title={gstLocked ? "Locked to the contract's GST rate so it matches the billing statement" : undefined}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">GST amount</Label>
              <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-sm">
                {formatCurrency(gstAmount)}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Total (incl. GST)</Label>
            <div className="rounded-md border-2 border-primary/30 bg-primary/5 px-3 py-2 text-base font-semibold">
              {formatCurrency(totalWithGst)}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-charge-date">
              Charge Date <span className="text-destructive">*</span>
            </Label>
            <Input
              id="edit-charge-date"
              type="date"
              value={chargeDate}
              onChange={(e) => setChargeDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-charge-notes">Notes</Label>
            <Textarea
              id="edit-charge-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

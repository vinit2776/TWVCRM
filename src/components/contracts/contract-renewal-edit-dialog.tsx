"use client";

import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { BILLING_CYCLE_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import type { Contract } from "@/types";

interface EditableItem {
  description: string;
  quantity: number;
  unit_price: number;
  unit?: string;
}

interface ContractRenewalEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: Contract;
  onSuccess: () => void;
}

export function ContractRenewalEditDialog({
  open,
  onOpenChange,
  contract,
  onSuccess,
}: ContractRenewalEditDialogProps) {
  const [saving, setSaving] = useState(false);
  const [tenureMonths, setTenureMonths] = useState(contract.tenure_months);
  const [seats, setSeats] = useState(contract.seats || 1);
  const [billingCycle, setBillingCycle] = useState<string>(contract.billing_cycle || "monthly");
  const [escalationPct, setEscalationPct] = useState(contract.escalation_percentage || 0);
  const [startDate, setStartDate] = useState(contract.start_date);
  const [items, setItems] = useState<EditableItem[]>(() =>
    (contract.items || []).map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      unit: item.unit,
    }))
  );

  const previewSubtotal = useMemo(
    () => items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0),
    [items]
  );
  const taxPct = Number(contract.tax_percentage || 18);
  const discountPct = Number(contract.discount_percentage || 0);
  const previewDiscount = Math.round(previewSubtotal * (discountPct / 100));
  const previewTaxable = previewSubtotal - previewDiscount;
  const previewTax = Math.round(previewTaxable * (taxPct / 100));
  const previewTotal = previewTaxable + previewTax;

  const previewEndDate = useMemo(() => {
    if (!startDate || !tenureMonths) return "";
    const start = new Date(startDate);
    start.setMonth(start.getMonth() + tenureMonths);
    start.setDate(start.getDate() - 1);
    return start.toISOString().split("T")[0];
  }, [startDate, tenureMonths]);

  const updateItem = (idx: number, patch: Partial<EditableItem>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const addItem = () => {
    setItems((prev) => [...prev, { description: "", quantity: 1, unit_price: 0 }]);
  };

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const hasEmptyDescription = items.some((i) => !i.description.trim());
  const hasInvalidQty = items.some((i) => !(i.quantity > 0));

  const handleSave = async () => {
    if (items.length === 0) {
      toast.error("At least one line item is required");
      return;
    }
    if (hasEmptyDescription) {
      toast.error("Every line item needs a description");
      return;
    }
    if (hasInvalidQty) {
      toast.error("Quantity must be greater than 0 for every line item");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/renew`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edit_terms: true,
          tenure_months: tenureMonths,
          start_date: startDate,
          seats,
          billing_cycle: billingCycle,
          escalation_percentage: escalationPct,
          items: items.map((i) => ({
            description: i.description.trim(),
            quantity: i.quantity,
            unit_price: i.unit_price,
            unit: i.unit,
            total: i.quantity * i.unit_price,
          })),
        }),
      });

      if (res.ok) {
        toast.success("Renewal terms updated");
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to update renewal terms");
      }
    } catch {
      toast.error("Network error — please try again");
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Edit Renewal Terms — {contract.contract_number}
          </DialogTitle>
          <DialogDescription>
            Correct or renegotiate any value on this draft renewal. Changes apply immediately —
            the addendum regenerates from these values the next time it&apos;s opened.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
          {/* Terms */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Renewal Terms</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="edit-tenure">Tenure (months)</Label>
                <Select
                  value={String(tenureMonths)}
                  onValueChange={(v) => setTenureMonths(parseInt(v) || contract.tenure_months)}
                >
                  <SelectTrigger id="edit-tenure" className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 60 }, (_, i) => i + 1).map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} month{m !== 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="edit-seats">Seats</Label>
                <Input
                  id="edit-seats"
                  type="number"
                  min={1}
                  max={500}
                  value={seats}
                  onChange={(e) => setSeats(parseInt(e.target.value) || 1)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="edit-billing">Billing Cycle</Label>
                <Select value={billingCycle} onValueChange={setBillingCycle}>
                  <SelectTrigger id="edit-billing" className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(BILLING_CYCLE_LABELS).map(([val, label]) => (
                      <SelectItem key={val} value={val}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="edit-start">Start Date</Label>
                <Input
                  id="edit-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1 col-span-2">
                <Label className="text-xs" htmlFor="edit-escalation">Escalation % (label only)</Label>
                <Input
                  id="edit-escalation"
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={escalationPct}
                  onChange={(e) => setEscalationPct(parseFloat(e.target.value) || 0)}
                  className="h-9"
                />
                <p className="text-[10px] text-muted-foreground">
                  Stored for reference on the addendum text — it does not auto-recalculate the line
                  items below. Edit the amounts directly if the escalation changes the rate.
                </p>
              </div>
            </div>
            {previewEndDate && (
              <p className="text-xs text-muted-foreground">
                Period: {formatDate(startDate)} → {formatDate(previewEndDate)} ({tenureMonths} months)
              </p>
            )}
          </div>

          <Separator />

          {/* Line items */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Line Items</p>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addItem}>
                <Plus className="mr-1 h-3 w-3" />
                Add Item
              </Button>
            </div>
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium w-20">Qty</th>
                    <th className="px-3 py-2 text-right font-medium w-28">Unit Price</th>
                    <th className="px-3 py-2 text-right font-medium w-28">Total</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr key={idx} className="border-b last:border-b-0">
                      <td className="px-3 py-2">
                        <Input
                          value={item.description}
                          onChange={(e) => updateItem(idx, { description: e.target.value })}
                          placeholder="e.g. 8 Seater Conference Room"
                          className="h-8 text-sm"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min={0}
                          value={item.quantity}
                          onChange={(e) => updateItem(idx, { quantity: parseFloat(e.target.value) || 0 })}
                          className="h-8 text-sm text-right"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min={0}
                          value={item.unit_price}
                          onChange={(e) => updateItem(idx, { unit_price: parseFloat(e.target.value) || 0 })}
                          className="h-8 text-sm text-right"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        {formatCurrency(item.quantity * item.unit_price)}
                      </td>
                      <td className="px-1 py-2">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          disabled={items.length === 1}
                          onClick={() => removeItem(idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs text-center pt-1">
              <div>
                <p className="text-muted-foreground">Subtotal</p>
                <p className="font-mono font-semibold">{formatCurrency(previewSubtotal)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">GST @ {taxPct}%</p>
                <p className="font-mono font-semibold">{formatCurrency(previewTax)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Total (incl. tax)</p>
                <p className="font-mono font-semibold">{formatCurrency(previewTotal)}</p>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

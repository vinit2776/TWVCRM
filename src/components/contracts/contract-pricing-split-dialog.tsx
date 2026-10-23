"use client";

import { useState, useMemo, useEffect } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Trash2, Scale } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { computePricingTotals } from "@/lib/contract-pricing-split";
import { toast } from "sonner";
import type { Contract, LineItem } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: Contract;
  onSuccess: () => void;
}

type Row = { description: string; quantity: number; unit_price: number; unit?: string; escalates: boolean };

const toRows = (items: LineItem[]): Row[] =>
  items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    unit_price: i.unit_price,
    unit: i.unit,
    escalates: i.escalates !== false,
  }));

export function ContractPricingSplitDialog({ open, onOpenChange, contract, onSuccess }: Props) {
  const [rows, setRows] = useState<Row[]>(() => toRows(contract.items || []));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setRows(toRows(contract.items || []));
  }, [open, contract.items]);

  const totals = useMemo(
    () => computePricingTotals(rows, Number(contract.tax_percentage || 18), Number(contract.discount_percentage || 0)),
    [rows, contract.tax_percentage, contract.discount_percentage]
  );

  const rowsValid = rows.length > 0 && rows.every((r) => r.description.trim() && r.quantity > 0 && r.unit_price >= 0);
  const canSubmit = rowsValid && reason.trim().length >= 10 && !saving;

  const update = (idx: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const handleSave = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/pricing-split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: rows, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        const open = json?.data?.open_statements_at_old_rate?.length ?? 0;
        toast.success(
          open > 0
            ? `Pricing updated. ${open} open invoice(s) still carry the old rate and need correcting.`
            : "Pricing updated"
        );
        setReason("");
        onOpenChange(false);
        onSuccess();
      } else {
        toast.error(json?.error || "Failed to update pricing");
      }
    } catch {
      toast.error("Network error — please try again");
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scale className="h-4 w-4" />
            Edit pricing split — {contract.contract_number}
          </DialogTitle>
          <DialogDescription>
            Split the monthly rate into components. A component marked fixed (e.g. maintenance)
            is skipped when the contract is renewed with an escalation. Invoices already issued are not changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_8rem_6rem_2rem] gap-2 text-xs text-muted-foreground">
            <span>Component</span>
            <span>Monthly amount</span>
            <span>Escalates</span>
            <span />
          </div>
          {rows.map((r, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_8rem_6rem_2rem] gap-2 items-center">
              <Input value={r.description} onChange={(e) => update(idx, { description: e.target.value })} className="h-9" />
              <Input
                type="number"
                min={0}
                step="0.01"
                value={r.unit_price}
                onChange={(e) => update(idx, { unit_price: parseFloat(e.target.value) || 0 })}
                className="h-9"
              />
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={r.escalates}
                  onChange={(e) => update(idx, { escalates: e.target.checked })}
                />
                {r.escalates ? "Escalates" : "Fixed"}
              </label>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Remove component"
                disabled={rows.length === 1}
                onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRows((rs) => [...rs, { description: "", quantity: 1, unit_price: 0, escalates: false }])}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add component
          </Button>

          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Current monthly rate (ex-GST)</span>
              <span>{formatCurrency(Number(contract.subtotal))}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>New monthly rate (ex-GST)</span>
              <span>{formatCurrency(totals.subtotal)}</span>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="split-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="split-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Agreed rent and maintenance split; maintenance does not escalate"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSubmit}>
            {saving ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>) : "Save pricing"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

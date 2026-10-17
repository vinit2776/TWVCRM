"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EXIT_CHARGE_TYPES, EXIT_CHARGE_TYPE_LABELS, type ExitChargeType } from "@/lib/contract-exit";
import type { ExitChargeRow } from "@/lib/contract-exit-server";

interface Props {
  contractId: string;
  charge: ExitChargeRow | null; // null = add
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function ChargeDialog({ contractId, charge, open, onOpenChange, onSaved }: Props) {
  const [type, setType] = useState<ExitChargeType>("breakage");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setType((charge?.charge_type as ExitChargeType) ?? "breakage");
    setDescription(charge?.description ?? "");
    setAmount(charge ? String(charge.amount) : "");
  }, [open, charge]);

  const submit = async () => {
    const n = Number(amount);
    if (!description.trim()) { toast.error("Describe the charge"); return; }
    if (!(n > 0)) { toast.error("Enter an amount above zero"); return; }
    setSaving(true);
    const url = charge ? `/api/contracts/${contractId}/exit/charges/${charge.id}` : `/api/contracts/${contractId}/exit/charges`;
    const res = await fetch(url, {
      method: charge ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ charge_type: type, description: description.trim(), amount: n }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(charge ? "Charge updated" : "Charge added");
      onOpenChange(false);
      onSaved();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Couldn't save the charge");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{charge ? "Edit charge" : "Add charge"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as ExitChargeType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXIT_CHARGE_TYPES.map((t) => <SelectItem key={t} value={t}>{EXIT_CHARGE_TYPE_LABELS[t]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="charge-desc">What</Label>
            <Input id="charge-desc" placeholder="Chair, 2 units" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="charge-amount">Amount (₹)</Label>
            <Input id="charge-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {charge ? "Save" : "Add charge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

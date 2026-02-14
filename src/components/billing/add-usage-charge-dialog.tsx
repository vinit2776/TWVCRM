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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface Contract {
  id: string;
  contract_number: string;
  lead?: { first_name: string; last_name: string; company?: string };
  total_amount: number;
}

interface AddUsageChargeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  contractId?: string;
}

export function AddUsageChargeDialog({
  open,
  onOpenChange,
  onSuccess,
  contractId,
}: AddUsageChargeDialogProps) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [selectedContractId, setSelectedContractId] = useState(contractId || "");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState<number>(1);
  const [unitPrice, setUnitPrice] = useState<number>(0);
  const [chargeDate, setChargeDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const total = quantity * unitPrice;

  // Fetch active contracts when dialog opens
  useEffect(() => {
    if (open) {
      setLoadingContracts(true);
      fetch("/api/contracts?status=active&limit=100")
        .then((res) => res.json())
        .then((json) => {
          setContracts(json.data || []);
        })
        .catch(() => {
          setContracts([]);
        })
        .finally(() => setLoadingContracts(false));

      // Pre-select contract if provided
      if (contractId) {
        setSelectedContractId(contractId);
      }
    }
  }, [open, contractId]);

  const resetForm = () => {
    setSelectedContractId(contractId || "");
    setDescription("");
    setQuantity(1);
    setUnitPrice(0);
    setChargeDate(new Date().toISOString().split("T")[0]);
    setNotes("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedContractId) {
      toast.error("Please select a contract");
      return;
    }
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
      const res = await fetch("/api/usage-charges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id: selectedContractId,
          description: description.trim(),
          quantity,
          unit_price: unitPrice,
          charge_date: chargeDate,
          notes: notes.trim() || undefined,
        }),
      });

      if (res.ok) {
        toast.success("Usage charge added successfully");
        resetForm();
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to add usage charge");
      }
    } catch {
      toast.error("Failed to add usage charge");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      resetForm();
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Usage Charge</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Contract Selector */}
          <div className="space-y-2">
            <Label htmlFor="charge-contract">
              Contract <span className="text-destructive">*</span>
            </Label>
            {loadingContracts ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading contracts...
              </div>
            ) : contracts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No active contracts found.
              </p>
            ) : (
              <Select
                value={selectedContractId}
                onValueChange={setSelectedContractId}
                disabled={!!contractId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a contract" />
                </SelectTrigger>
                <SelectContent>
                  {contracts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contract_number}
                      {c.lead
                        ? ` - ${c.lead.company || `${c.lead.first_name} ${c.lead.last_name}`}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="charge-description">
              Description <span className="text-destructive">*</span>
            </Label>
            <Input
              id="charge-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Additional meeting room hours"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Quantity */}
            <div className="space-y-2">
              <Label htmlFor="charge-quantity">
                Quantity <span className="text-destructive">*</span>
              </Label>
              <Input
                id="charge-quantity"
                type="number"
                min={0.01}
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(parseFloat(e.target.value) || 0)}
              />
            </div>

            {/* Unit Price */}
            <div className="space-y-2">
              <Label htmlFor="charge-unit-price">
                Unit Price <span className="text-destructive">*</span>
              </Label>
              <Input
                id="charge-unit-price"
                type="number"
                min={0.01}
                step="any"
                value={unitPrice}
                onChange={(e) => setUnitPrice(parseFloat(e.target.value) || 0)}
              />
            </div>
          </div>

          {/* Total (readonly) */}
          <div className="space-y-2">
            <Label>Total</Label>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium">
              {formatCurrency(total)}
            </div>
          </div>

          {/* Charge Date */}
          <div className="space-y-2">
            <Label htmlFor="charge-date">
              Charge Date <span className="text-destructive">*</span>
            </Label>
            <Input
              id="charge-date"
              type="date"
              value={chargeDate}
              onChange={(e) => setChargeDate(e.target.value)}
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="charge-notes">Notes</Label>
            <Textarea
              id="charge-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || contracts.length === 0}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Charge
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
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
import { Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface Contract {
  id: string;
  contract_number: string;
  total_amount: number;
  lead?: { first_name: string; last_name: string; company?: string };
}

interface UsageCharge {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

interface GenerateStatementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  contractId?: string;
}

export function GenerateStatementDialog({
  open,
  onOpenChange,
  onSuccess,
  contractId,
}: GenerateStatementDialogProps) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [selectedContractId, setSelectedContractId] = useState(
    contractId || ""
  );
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Preview state
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [contractFixedAmount, setContractFixedAmount] = useState<number>(0);
  const [pendingCharges, setPendingCharges] = useState<UsageCharge[]>([]);
  const [pendingChargesTotal, setPendingChargesTotal] = useState<number>(0);

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

      if (contractId) {
        setSelectedContractId(contractId);
      }
    }
  }, [open, contractId]);

  // Fetch preview data when contract and period are selected
  const fetchPreview = useCallback(async () => {
    if (!selectedContractId || !periodStart || !periodEnd) {
      setContractFixedAmount(0);
      setPendingCharges([]);
      setPendingChargesTotal(0);
      return;
    }

    setLoadingPreview(true);
    try {
      // Fetch contract details for fixed amount
      const contractRes = await fetch(`/api/contracts/${selectedContractId}`);
      if (contractRes.ok) {
        const contractJson = await contractRes.json();
        setContractFixedAmount(contractJson.data?.total_amount || 0);
      }

      // Fetch pending usage charges for the period
      const chargeParams = new URLSearchParams({
        contract_id: selectedContractId,
        status: "pending",
        date_from: periodStart,
        date_to: periodEnd,
      });
      const chargesRes = await fetch(`/api/usage-charges?${chargeParams}`);
      if (chargesRes.ok) {
        const chargesJson = await chargesRes.json();
        const charges = chargesJson.data || [];
        setPendingCharges(charges);
        setPendingChargesTotal(
          charges.reduce(
            (sum: number, c: UsageCharge) => sum + (c.total || 0),
            0
          )
        );
      }
    } catch {
      // Silently fail preview; user can still submit
    } finally {
      setLoadingPreview(false);
    }
  }, [selectedContractId, periodStart, periodEnd]);

  useEffect(() => {
    fetchPreview();
  }, [fetchPreview]);

  const resetForm = () => {
    setSelectedContractId(contractId || "");
    setPeriodStart("");
    setPeriodEnd("");
    setNotes("");
    setContractFixedAmount(0);
    setPendingCharges([]);
    setPendingChargesTotal(0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedContractId) {
      toast.error("Please select a contract");
      return;
    }
    if (!periodStart) {
      toast.error("Please select a period start date");
      return;
    }
    if (!periodEnd) {
      toast.error("Please select a period end date");
      return;
    }
    if (new Date(periodEnd) <= new Date(periodStart)) {
      toast.error("Period end must be after period start");
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/billing-statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id: selectedContractId,
          period_start: periodStart,
          period_end: periodEnd,
          notes: notes.trim() || undefined,
        }),
      });

      if (res.ok) {
        toast.success("Billing statement generated successfully");
        resetForm();
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to generate statement");
      }
    } catch {
      toast.error("Failed to generate statement");
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

  const grandTotal = contractFixedAmount + pendingChargesTotal;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate Billing Statement</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Contract Selector */}
          <div className="space-y-2">
            <Label htmlFor="stmt-contract">
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

          <div className="grid grid-cols-2 gap-4">
            {/* Period Start */}
            <div className="space-y-2">
              <Label htmlFor="stmt-period-start">
                Period Start <span className="text-destructive">*</span>
              </Label>
              <Input
                id="stmt-period-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>

            {/* Period End */}
            <div className="space-y-2">
              <Label htmlFor="stmt-period-end">
                Period End <span className="text-destructive">*</span>
              </Label>
              <Input
                id="stmt-period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>

          {/* Preview Section */}
          {selectedContractId && periodStart && periodEnd && (
            <div className="rounded-md border bg-muted/30 p-4 space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                Statement Preview
                {loadingPreview && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
              </h4>
              {!loadingPreview && (
                <>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Fixed Amount (from contract)
                      </span>
                      <span className="font-medium">
                        {formatCurrency(contractFixedAmount)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Pending Usage Charges ({pendingCharges.length} item
                        {pendingCharges.length !== 1 ? "s" : ""})
                      </span>
                      <span className="font-medium">
                        {formatCurrency(pendingChargesTotal)}
                      </span>
                    </div>
                    <div className="border-t pt-2 flex justify-between font-semibold">
                      <span>Estimated Total</span>
                      <span>{formatCurrency(grandTotal)}</span>
                    </div>
                  </div>
                  {pendingCharges.length === 0 && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <AlertCircle className="h-3 w-3" />
                      No pending usage charges found for this period.
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="stmt-notes">Notes</Label>
            <Textarea
              id="stmt-notes"
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
              Generate Statement
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { BILLING_CYCLES, BILLING_CYCLE_LABELS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import { LocationSelector } from "@/components/shared/location-selector";
import type { Proposal } from "@/types";

interface CreateContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  leadId: string;
}

export function CreateContractDialog({
  open,
  onOpenChange,
  onSuccess,
  leadId,
}: CreateContractDialogProps) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loadingProposals, setLoadingProposals] = useState(false);
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [billingCycle, setBillingCycle] = useState("");
  const [tenureMonths, setTenureMonths] = useState<number>(12);
  const [startDate, setStartDate] = useState("");
  const [seats, setSeats] = useState<number>(1);
  const [termsAndConditions, setTermsAndConditions] = useState("");
  const [notes, setNotes] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Fetch accepted proposals when dialog opens
  useEffect(() => {
    if (open) {
      setLoadingProposals(true);
      fetch(`/api/proposals?lead_id=${leadId}&status=accepted`)
        .then((res) => res.json())
        .then((json) => {
          setProposals(json.data || []);
        })
        .catch(() => {
          setProposals([]);
        })
        .finally(() => setLoadingProposals(false));

      // Also try to get lead's seat_capacity for default seats
      fetch(`/api/leads/${leadId}`)
        .then((res) => res.json())
        .then((json) => {
          if (json.data?.seat_capacity) {
            setSeats(json.data.seat_capacity);
          }
        })
        .catch(() => {});
    }
  }, [open, leadId]);

  const selectedProposal = useMemo(
    () => proposals.find((p) => p.id === selectedProposalId) || null,
    [proposals, selectedProposalId]
  );

  // Auto-populate location from selected proposal
  useEffect(() => {
    if (selectedProposal?.location_id) {
      setLocationId(selectedProposal.location_id);
    }
  }, [selectedProposal]);

  // Calculate end date
  const calculatedEndDate = useMemo(() => {
    if (!startDate || !tenureMonths) return "";
    const start = new Date(startDate);
    start.setMonth(start.getMonth() + tenureMonths);
    return start.toISOString().split("T")[0];
  }, [startDate, tenureMonths]);

  const resetForm = () => {
    setSelectedProposalId("");
    setBillingCycle("");
    setTenureMonths(12);
    setStartDate("");
    setSeats(1);
    setTermsAndConditions("");
    setNotes("");
    setLocationId(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedProposalId) {
      toast.error("Please select a proposal");
      return;
    }
    if (!billingCycle) {
      toast.error("Please select a billing cycle");
      return;
    }
    if (!startDate) {
      toast.error("Please select a start date");
      return;
    }
    if (tenureMonths <= 0) {
      toast.error("Tenure must be a positive number");
      return;
    }
    if (seats <= 0) {
      toast.error("Seats must be a positive number");
      return;
    }

    setSubmitting(true);

    const body = {
      proposal_id: selectedProposalId,
      location_id: locationId || undefined,
      billing_cycle: billingCycle,
      tenure_months: tenureMonths,
      start_date: startDate,
      seats,
      terms_and_conditions: termsAndConditions.trim() || undefined,
      notes: notes.trim() || undefined,
    };

    const res = await fetch("/api/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSubmitting(false);
    if (res.ok) {
      toast.success("Contract created successfully");
      resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to create contract");
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
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Contract</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Proposal Selector */}
          <div className="space-y-2">
            <Label htmlFor="contract-proposal">
              Proposal <span className="text-destructive">*</span>
            </Label>
            {loadingProposals ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading accepted proposals...
              </div>
            ) : proposals.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No accepted proposals found for this lead. A proposal must be accepted before creating a contract.
              </p>
            ) : (
              <Select value={selectedProposalId} onValueChange={setSelectedProposalId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an accepted proposal" />
                </SelectTrigger>
                <SelectContent>
                  {proposals.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.proposal_number} - {p.title} - {formatCurrency(p.total_amount)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Selected Proposal Info */}
          {selectedProposal && (
            <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-1">
              <p><span className="text-muted-foreground">Title:</span> {selectedProposal.title}</p>
              <p><span className="text-muted-foreground">Items:</span> {selectedProposal.items.length} line item{selectedProposal.items.length !== 1 ? "s" : ""}</p>
              <p><span className="text-muted-foreground">Total Amount:</span> <span className="font-medium">{formatCurrency(selectedProposal.total_amount)}</span></p>
            </div>
          )}

          {/* Location */}
          <div className="space-y-2">
            <Label>Location</Label>
            <LocationSelector
              value={locationId}
              onValueChange={setLocationId}
              placeholder="Select center"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Billing Cycle */}
            <div className="space-y-2">
              <Label htmlFor="contract-billing-cycle">
                Billing Cycle <span className="text-destructive">*</span>
              </Label>
              <Select value={billingCycle} onValueChange={setBillingCycle}>
                <SelectTrigger>
                  <SelectValue placeholder="Select billing cycle" />
                </SelectTrigger>
                <SelectContent>
                  {BILLING_CYCLES.map((cycle) => (
                    <SelectItem key={cycle} value={cycle}>
                      {BILLING_CYCLE_LABELS[cycle]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Tenure */}
            <div className="space-y-2">
              <Label htmlFor="contract-tenure">
                Tenure (months) <span className="text-destructive">*</span>
              </Label>
              <Input
                id="contract-tenure"
                type="number"
                min={1}
                value={tenureMonths}
                onChange={(e) => setTenureMonths(parseInt(e.target.value) || 0)}
              />
            </div>

            {/* Start Date */}
            <div className="space-y-2">
              <Label htmlFor="contract-start-date">
                Start Date <span className="text-destructive">*</span>
              </Label>
              <Input
                id="contract-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            {/* Seats */}
            <div className="space-y-2">
              <Label htmlFor="contract-seats">
                Seats <span className="text-destructive">*</span>
              </Label>
              <Input
                id="contract-seats"
                type="number"
                min={1}
                value={seats}
                onChange={(e) => setSeats(parseInt(e.target.value) || 0)}
              />
            </div>
          </div>

          {/* Calculated End Date */}
          {calculatedEndDate && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <span className="text-muted-foreground">Calculated End Date:</span>{" "}
              <span className="font-medium">{new Date(calculatedEndDate).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" })}</span>
            </div>
          )}

          {/* Terms & Conditions */}
          <div className="space-y-2">
            <Label htmlFor="contract-terms">Terms & Conditions</Label>
            <Textarea
              id="contract-terms"
              value={termsAndConditions}
              onChange={(e) => setTermsAndConditions(e.target.value)}
              placeholder="Add terms and conditions..."
              rows={3}
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="contract-notes">Notes</Label>
            <Textarea
              id="contract-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes..."
              rows={2}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || proposals.length === 0}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Contract
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

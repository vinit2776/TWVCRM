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
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface AddContractFacilityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  contractId: string;
}

interface FacilityName {
  name: string;
  unit: string;
}

export function AddContractFacilityDialog({
  open,
  onOpenChange,
  onSuccess,
  contractId,
}: AddContractFacilityDialogProps) {
  const [existingNames, setExistingNames] = useState<FacilityName[]>([]);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [costPerUnit, setCostPerUnit] = useState<number>(0);
  const [freeQuota, setFreeQuota] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Fetch existing facility names for autocomplete
  useEffect(() => {
    if (open) {
      fetch("/api/accounting/contract-facilities/names")
        .then((r) => r.json())
        .then((d) => setExistingNames(d.data || []))
        .catch(() => {});
    }
  }, [open]);

  const filteredSuggestions = existingNames.filter(
    (f) => f.name.toLowerCase().includes(name.toLowerCase()) && name.length > 0
  );

  const handleSelectSuggestion = (suggestion: FacilityName) => {
    setName(suggestion.name);
    setUnit(suggestion.unit);
    setShowSuggestions(false);
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error("Facility name is required");
      return;
    }
    if (!unit.trim()) {
      toast.error("Unit is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/accounting/contract-facilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id: contractId,
          name: name.trim(),
          unit: unit.trim(),
          cost_per_unit: costPerUnit,
          free_quota: freeQuota,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to add facility");
        return;
      }

      toast.success("Facility added");
      onSuccess();
      onOpenChange(false);
      resetForm();
    } catch {
      toast.error("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setName("");
    setUnit("");
    setCostPerUnit(0);
    setFreeQuota(0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Facility</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="relative">
            <Label htmlFor="facility-name">Facility Name</Label>
            <Input
              id="facility-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
              placeholder="e.g., Printing, Meeting Room, Cafeteria"
            />
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-popover border rounded-md shadow-md max-h-40 overflow-y-auto">
                {filteredSuggestions.map((s) => (
                  <button
                    key={s.name}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent flex justify-between"
                    onMouseDown={() => handleSelectSuggestion(s)}
                  >
                    <span>{s.name}</span>
                    <span className="text-muted-foreground">{s.unit}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="facility-unit">Unit</Label>
            <Input
              id="facility-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="e.g., pages, hours, meals"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="cost-per-unit">Cost per Unit (₹)</Label>
              <Input
                id="cost-per-unit"
                type="number"
                min={0}
                step={0.01}
                value={costPerUnit}
                onChange={(e) => setCostPerUnit(parseFloat(e.target.value) || 0)}
              />
            </div>
            <div>
              <Label htmlFor="free-quota">Free Quota</Label>
              <Input
                id="free-quota"
                type="number"
                min={0}
                step={0.01}
                value={freeQuota}
                onChange={(e) => setFreeQuota(parseFloat(e.target.value) || 0)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add Facility
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

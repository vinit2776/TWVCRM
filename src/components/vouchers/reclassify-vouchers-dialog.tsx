"use client";

import { useState } from "react";
import { Shuffle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Label } from "@/components/ui/label";
import { VOUCHER_VALIDITY_OPTIONS, VOUCHER_VALIDITY_LABELS } from "@/lib/constants";
import { getValidityLabel } from "@/lib/utils";

interface ReclassifyVouchersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Number of unclassified vouchers that will be affected */
  count: number;
  /** Optional location filter currently active on the page */
  locationId?: string | null;
  onSuccess: () => void;
}

export function ReclassifyVouchersDialog({
  open,
  onOpenChange,
  count,
  locationId,
  onSuccess,
}: ReclassifyVouchersDialogProps) {
  const [validityDays, setValidityDays] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!validityDays) return;
    setLoading(true);
    setError(null);

    try {
      const body: Record<string, unknown> = { validity_days: Number(validityDays) };
      if (locationId) body.location_id = locationId;

      const res = await fetch("/api/vouchers/reclassify", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error || "Failed to reclassify vouchers.");
        return;
      }

      onSuccess();
      onOpenChange(false);
      setValidityDays("");
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const selectedLabel = validityDays
    ? getValidityLabel(Number(validityDays))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shuffle className="h-5 w-5 text-primary" />
            Set Validity for Unclassified Vouchers
          </DialogTitle>
          <DialogDescription>
            {count > 0
              ? `${count} unclassified voucher${count === 1 ? "" : "s"} will be updated with the selected validity period.`
              : "No unclassified vouchers available to update."}
            {" "}Only <strong>available</strong> (unissued) vouchers are affected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="validity-select">Validity Period</Label>
            <Select value={validityDays} onValueChange={setValidityDays}>
              <SelectTrigger id="validity-select">
                <SelectValue placeholder="Select duration…" />
              </SelectTrigger>
              <SelectContent>
                {VOUCHER_VALIDITY_OPTIONS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {VOUCHER_VALIDITY_LABELS[days] ?? getValidityLabel(days)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedLabel && count > 0 && (
            <p className="text-sm text-muted-foreground rounded-md bg-muted px-3 py-2">
              All {count} unclassified voucher{count === 1 ? "" : "s"} will be set to{" "}
              <strong>{selectedLabel}</strong>.
            </p>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!validityDays || count === 0 || loading}
          >
            {loading ? "Updating…" : `Update ${count} Voucher${count === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

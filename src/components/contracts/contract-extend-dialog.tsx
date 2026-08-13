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
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Loader2, CalendarPlus } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import type { Contract } from "@/types";

const MAX_LIFETIME_EXTENSION_DAYS = 60;

interface ExtendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: Contract;
  onSuccess: () => void;
}

export function ContractExtendDialog({
  open,
  onOpenChange,
  contract,
  onSuccess,
}: ExtendDialogProps) {
  const [extending, setExtending] = useState(false);
  const [days, setDays] = useState(5);
  const [reason, setReason] = useState("");

  const daysUsed = contract.days_extended || 0;
  const remaining = Math.max(0, MAX_LIFETIME_EXTENSION_DAYS - daysUsed);

  const previewEndDate = useMemo(() => {
    if (!days || days < 1) return "";
    const end = new Date(contract.end_date + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + days);
    return end.toISOString().slice(0, 10);
  }, [contract.end_date, days]);

  const daysValid = days >= 1 && days <= remaining;
  const canSubmit = daysValid && reason.trim().length > 0 && !extending;

  const handleExtend = async () => {
    if (!canSubmit) return;
    setExtending(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/extend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days, reason: reason.trim() }),
      });

      if (res.ok) {
        const json = await res.json();
        toast.success(`Contract extended to ${formatDate(json.data.end_date)}`);
        setReason("");
        setDays(5);
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to extend contract");
      }
    } catch {
      toast.error("Network error — please try again");
    }
    setExtending(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-4 w-4" />
            Extend Contract — {contract.contract_number}
          </DialogTitle>
          <DialogDescription>
            Push the current end date forward without changing rate or terms.
            Extensions are capped at {MAX_LIFETIME_EXTENSION_DAYS} days total per contract.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs flex justify-between">
            <span className="text-muted-foreground">Extension allowance used</span>
            <span className="font-medium">{daysUsed} / {MAX_LIFETIME_EXTENSION_DAYS} days ({remaining} remaining)</span>
          </div>

          <div className="space-y-1">
            <Label htmlFor="extend-days">Days to extend</Label>
            <Input
              id="extend-days"
              type="number"
              min={1}
              max={remaining}
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value) || 0)}
              className="h-9"
            />
            {!daysValid && (
              <p className="text-xs text-destructive">
                {remaining <= 0
                  ? "No extension days remaining — use Renewal instead."
                  : `Enter a value between 1 and ${remaining}.`}
              </p>
            )}
          </div>

          {previewEndDate && daysValid && (
            <p className="text-xs text-muted-foreground">
              Current end date: {formatDate(contract.end_date)} → New end date: <span className="font-medium text-foreground">{formatDate(previewEndDate)}</span>
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="extend-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="extend-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Customer needs a few extra days before renewal paperwork is signed..."
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleExtend} disabled={!canSubmit}>
            {extending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Extending...
              </>
            ) : (
              <>
                <CalendarPlus className="mr-2 h-4 w-4" />
                Extend Contract
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

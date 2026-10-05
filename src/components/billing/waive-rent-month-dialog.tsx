"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

/**
 * Admin-only: record that one missed rent month won't be billed through the
 * CRM. Shared by Billing → Unbilled and the contract page's Monthly Invoices
 * card. Nothing is sent to the client — the month just stops being reported
 * as a gap, and it can still be billed later from the contract page.
 */
export function WaiveRentMonthDialog({
  target,
  onClose,
  onWaived,
}: {
  /** null = closed. month is YYYY-MM-01. */
  target: { contractId: string; contractNumber?: string; month: string; monthLabel: string } | null;
  onClose: () => void;
  onWaived: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setReason(""); setError(null); }, [target]);

  const submit = async () => {
    if (!target) return;
    if (reason.trim().length < 5) {
      setError("Give a short reason (at least 5 characters)");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${target.contractId}/rent-waivers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waived_month: target.month, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Couldn't waive this month");
        return;
      }
      toast.success(`${target.monthLabel} waived`);
      onClose();
      await onWaived();
    } catch {
      setError("Couldn't waive this month");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Waive {target?.monthLabel} rent{target?.contractNumber ? ` — ${target.contractNumber}` : ""}
          </DialogTitle>
          <DialogDescription>
            Nothing is sent to the client. This month stops showing as unbilled. It can still be
            billed later from the contract page, and the admin can undo the waiver there.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Textarea
            value={reason}
            onChange={(e) => { setReason(e.target.value); setError(null); }}
            placeholder="Collected outside the CRM — paid annually in advance"
            rows={3}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Waive month
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

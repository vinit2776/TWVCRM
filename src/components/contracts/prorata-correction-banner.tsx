"use client";

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface Preview {
  statement_number: string | null;
  current_total: number;
  corrected_total: number;
  differs: boolean;
  eligible: boolean;
  blocker: string | null;
}

interface Props {
  contractId: string;
  refreshKey?: string | null;
  onSuccess: () => void;
}

/**
 * Admin-only. Shows when the pro-rata statement no longer matches the
 * contract's current rate, and lets the admin correct it in place while it is
 * still unissued. Sends nothing to the customer or to accounts.
 */
export function ProrataCorrectionBanner({ contractId, refreshKey, onSuccess }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/contracts/${contractId}/prorata-correction`);
    if (res.ok) setPreview((await res.json()).data);
  }, [contractId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (!preview || !preview.differs) return null;

  const apply = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/prorata-correction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), expected_total: preview.corrected_total }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        toast.success("Invoice amount corrected");
        setOpen(false);
        setReason("");
        await load();
        onSuccess();
      } else {
        toast.error(json?.error || "Failed to correct the invoice");
      }
    } catch {
      toast.error("Network error — nothing was changed");
    }
    setSaving(false);
  };

  return (
    <>
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            Invoice {preview.statement_number ?? ""} is {formatCurrency(preview.current_total)}, but the contract&apos;s
            current rate gives {formatCurrency(preview.corrected_total)}.
            {!preview.eligible && preview.blocker ? ` It can&apos;t be corrected here: ${preview.blocker}` : ""}
          </p>
        </div>
        {preview.eligible && (
          <Button size="sm" variant="outline" className="w-full" onClick={() => setOpen(true)}>
            Correct invoice to {formatCurrency(preview.corrected_total)}
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct pro-rata invoice</DialogTitle>
            <DialogDescription>
              Changes {preview.statement_number ?? "the statement"} from {formatCurrency(preview.current_total)} to{" "}
              {formatCurrency(preview.corrected_total)}. It keeps its number and its place in the Tally Inbox.
              Nothing is sent to the customer. Accounts must issue the GST invoice at the new amount, so tell
              them if they have already started it in Tally.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason, e.g. Maintenance was escalated by mistake; rate corrected"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={apply} disabled={saving || reason.trim().length < 10}>
              {saving ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>) : "Correct invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

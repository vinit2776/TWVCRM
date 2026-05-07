"use client";

/**
 * MarkComplimentaryDialog — post-hoc "this should have been a comp"
 * action. Used when staff realises after the fact that a booking
 * should be free (manager goodwill, demo, staff use, etc.).
 *
 * Captures a locked-picklist reason + optional details. The endpoint
 * zeros the booking total and flips payment_status to 'waived'.
 *
 * Refuses to run if money has already been collected — staff must
 * issue a refund first via the cancel-with-refund flow. The dialog
 * surfaces this constraint up-front so staff doesn't waste time.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Gift, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import {
  BOOKING_COMPLIMENTARY_REASONS,
  BOOKING_COMPLIMENTARY_REASON_LABELS,
} from "@/lib/constants";
import type { BookingComplimentaryReason } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  bookingNumber: string;
  /** Current grand total. Display only — endpoint zeros it server-side. */
  currentTotal: number;
  /** Whether ANY verified payment exists. Disables the dialog if true. */
  hasCollectedPayment: boolean;
  onSuccess: () => void;
}

export function MarkComplimentaryDialog({
  open, onOpenChange, bookingId, bookingNumber,
  currentTotal, hasCollectedPayment, onSuccess,
}: Props) {
  const [reason, setReason] = useState<BookingComplimentaryReason | "">("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reason) {
      toast.error("Please pick a reason");
      return;
    }
    if (reason === "other" && !details.trim()) {
      toast.error("Details required when reason is 'other'");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/mark-complimentary`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, details: details.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to mark complimentary");
        return;
      }
      toast.success(`${bookingNumber} marked complimentary`);
      onSuccess();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift className="h-4 w-4 text-emerald-600" />
            Mark as Complimentary — {bookingNumber}
          </DialogTitle>
        </DialogHeader>

        {hasCollectedPayment ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <strong>Cannot mark complimentary directly.</strong>
              <p className="mt-1 text-xs">
                Payment has already been collected on this booking. You&apos;ll need to issue a
                refund first via the Cancel-with-refund flow, then come back here if still applicable.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Zeros the booking total and marks it as waived. The reason is stored for finance
              reporting and shows on the booking&apos;s payment summary banner.
              {currentTotal > 0 && (
                <>
                  {" "}Current total: <span className="font-semibold text-foreground">{formatCurrency(currentTotal)}</span> → will become <span className="font-semibold text-foreground">₹0</span>.
                </>
              )}
            </p>

            <div className="space-y-2">
              <Label>Reason *</Label>
              <div className="grid grid-cols-1 gap-1.5">
                {BOOKING_COMPLIMENTARY_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={`text-left rounded-md border px-3 py-2 text-sm transition-colors ${
                      reason === r
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    {BOOKING_COMPLIMENTARY_REASON_LABELS[r]}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="comp-details" className="text-xs">
                Details {reason === "other" && <span className="text-destructive">*</span>}
              </Label>
              <Textarea
                id="comp-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={
                  reason === "other"
                    ? "Please describe the reason"
                    : "Optional context (e.g., 'Mic broke last visit, comping a 2-hour session')"
                }
                rows={2}
                className="text-sm"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={submitting || !reason}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {submitting
                  ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Marking…</>
                  : "Mark Complimentary"}
              </Button>
            </div>
          </div>
        )}

        {hasCollectedPayment && (
          <div className="flex justify-end pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

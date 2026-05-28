"use client";

/**
 * MarkComplimentaryDialog — two modes depending on the caller's role:
 *
 *   Admin / Manager:
 *     Direct comp — zeros the booking total immediately. No approval needed.
 *     Calls PATCH /api/bookings/[id]/mark-complimentary.
 *
 *   Floor Manager:
 *     Request comp — creates an inbox approval request.
 *     Admins/managers are notified via email, WhatsApp, and in-app bell.
 *     Calls POST /api/bookings/[id]/comp-request.
 *     Request expires in 24 hours if not acted on.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Gift, AlertCircle, Clock, CheckCircle2, Send } from "lucide-react";
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
  /** Role of the current user. Determines direct-comp vs. request-approval flow. */
  userRole?: string | null;
}

export function MarkComplimentaryDialog({
  open, onOpenChange, bookingId, bookingNumber,
  currentTotal, hasCollectedPayment, onSuccess, userRole,
}: Props) {
  const [reason, setReason] = useState<BookingComplimentaryReason | "">("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false); // floor-manager success state

  const isFloorManager = userRole === "floor_manager";

  function resetForm() {
    setReason("");
    setDetails("");
    setSubmitted(false);
  }

  function handleClose(val: boolean) {
    if (!val) resetForm();
    onOpenChange(val);
  }

  // ── Admin / Manager: direct comp ─────────────────────────────────────────
  const submitDirect = async () => {
    if (!reason) { toast.error("Please pick a reason"); return; }
    if (reason === "other" && !details.trim()) { toast.error("Details required when reason is 'other'"); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/mark-complimentary`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, details: details.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to mark complimentary"); return; }
      toast.success(`${bookingNumber} marked complimentary`);
      onSuccess();
      handleClose(false);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Floor Manager: request approval ──────────────────────────────────────
  const submitRequest = async () => {
    if (!reason) { toast.error("Please pick a reason"); return; }
    if (reason === "other" && !details.trim()) { toast.error("Details required when reason is 'other'"); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/comp-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, details: details.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to submit request"); return; }
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  const title = isFloorManager ? "Request Complimentary Approval" : "Mark as Complimentary";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift className="h-4 w-4 text-emerald-600" />
            {title} — {bookingNumber}
          </DialogTitle>
        </DialogHeader>

        {/* ── Payment collected guard ── */}
        {hasCollectedPayment ? (
          <>
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <strong>Cannot {isFloorManager ? "request comp" : "mark complimentary"} directly.</strong>
                <p className="mt-1 text-xs">
                  Payment has already been collected on this booking. A refund must be issued
                  first via the Cancel-with-refund flow, then re-attempt this action.
                </p>
              </div>
            </div>
            <div className="flex justify-end pt-1">
              <Button variant="outline" onClick={() => handleClose(false)}>Close</Button>
            </div>
          </>

        ) : submitted ? (
          /* ── Floor manager success state ── */
          <div className="space-y-4">
            <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-emerald-800">Request submitted</p>
                <p className="text-xs text-emerald-700 mt-1">
                  Managers have been notified by email, WhatsApp, and in-app alert.
                  You&apos;ll receive a notification once it&apos;s reviewed.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>Request expires in 24 hours if not acted on.</span>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => handleClose(false)}>Done</Button>
            </div>
          </div>

        ) : (
          /* ── Form ── */
          <div className="space-y-4">
            {isFloorManager ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 flex items-start gap-2">
                <Send className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <p>
                  Your request will be sent to all managers for approval.
                  You&apos;ll be notified once it&apos;s reviewed.
                  {currentTotal > 0 && (
                    <> The current total is <strong>{formatCurrency(currentTotal)}</strong> — this will be zeroed if approved.</>
                  )}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Zeros the booking total and marks it as waived. The reason is stored for finance
                reporting and shows on the booking&apos;s payment summary banner.
                {currentTotal > 0 && (
                  <> Current total: <span className="font-semibold text-foreground">{formatCurrency(currentTotal)}</span> → will become <span className="font-semibold text-foreground">₹0</span>.</>
                )}
              </p>
            )}

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
              <Button variant="ghost" onClick={() => handleClose(false)} disabled={submitting}>
                Cancel
              </Button>
              {isFloorManager ? (
                <Button
                  onClick={submitRequest}
                  disabled={submitting || !reason}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  {submitting
                    ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Submitting…</>
                    : <><Send className="h-4 w-4 mr-1" />Request Approval</>}
                </Button>
              ) : (
                <Button
                  onClick={submitDirect}
                  disabled={submitting || !reason}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  {submitting
                    ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Marking…</>
                    : "Mark Complimentary"}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

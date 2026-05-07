"use client";

/**
 * WrapUpDialog — guided close-out checklist for a checked_out booking.
 *
 * Replaces the implicit "click 5 buttons in some order, hope you got
 * them all" flow with an explicit ritual:
 *
 *   ✅ Payment      (hard gate — can't close with unpaid balance)
 *   ⬜ Internal rating              [Rate now] [Skip]
 *   ⬜ Customer feedback             [Send]    [Skip]
 *   ✅ Outstanding (past visits)    None / N pending
 *
 * Skips are recorded so management can see "% closed without rating".
 * "Mark Closed" is the staff member's affirmation — never auto-derived.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Loader2, CheckCircle2, Circle, AlertCircle, Star, MessageCircle, IndianRupee, ScrollText, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { Booking, BookingPayment } from "@/types";

type StepKey = "payment" | "rating" | "feedback" | "outstanding";
type StepState = "done" | "skipped" | "pending" | "error";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking: Booking;
  existingPayments: BookingPayment[];
  outstandingCount: number;
  /** Existing dialogs we orchestrate. Parent owns the state. */
  onOpenRateCustomer: () => void;
  onOpenSendFeedback: () => void;
  /** Called after successful close so parent refetches booking. */
  onClosed: () => void;
}

export function WrapUpDialog({
  open, onOpenChange, booking, existingPayments, outstandingCount,
  onOpenRateCustomer, onOpenSendFeedback, onClosed,
}: Props) {
  // Per-step state. "done" = action completed; "skipped" = staff said
  // skip; "pending" = neither yet; "error" = action attempted and
  // failed (rare).
  const [stepStates, setStepStates] = useState<Record<StepKey, StepState>>({
    payment: "pending",
    rating: "pending",
    feedback: "pending",
    outstanding: "pending",
  });
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Recompute payment + outstanding state on open / on data change.
  // These two are derived (not toggleable by staff) — they reflect the
  // current booking state.
  useEffect(() => {
    if (!open) return;

    // Payment: hard gate. Settled means paid / waived / posted_to_bill /
    // prepaid OR verified-payments cover total.
    const SETTLED = new Set(["paid", "waived", "posted_to_bill", "prepaid"]);
    const grandTotal = Number(booking.total_amount_with_gst) || Number(booking.total_amount);
    const paidSoFar = existingPayments
      .filter((p) => p.status === "verified")
      .reduce((s, p) => s + Number(p.amount), 0);
    const paymentSettled = SETTLED.has(booking.payment_status) || paidSoFar + 0.01 >= grandTotal;
    const ratingDone = !!booking.feedback;
    const feedbackDone = !!booking.customer_feedback;

    setStepStates({
      payment: paymentSettled ? "done" : "pending",
      rating: ratingDone ? "done" : "pending",
      feedback: feedbackDone ? "done" : "pending",
      // Outstanding is "done" if the count is 0, otherwise informational
      // — doesn't block close, but staff sees the badge.
      outstanding: outstandingCount === 0 ? "done" : "pending",
    });
  }, [open, booking, existingPayments, outstandingCount]);

  const skip = (k: StepKey) => setStepStates((s) => ({ ...s, [k]: "skipped" }));
  const unskip = (k: StepKey) => setStepStates((s) => ({ ...s, [k]: "pending" }));

  const allReady = stepStates.payment === "done"; // payment is the only HARD gate

  const close = async () => {
    if (!allReady) {
      toast.error("Cannot close — payment not yet settled");
      return;
    }
    setSubmitting(true);
    const skipped: string[] = (Object.keys(stepStates) as StepKey[])
      .filter((k) => stepStates[k] === "skipped");
    try {
      const res = await fetch(`/api/bookings/${booking.id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skipped_steps: skipped,
          notes: notes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to close booking");
        return;
      }
      toast.success(`Booking ${booking.booking_number} closed`);
      onClosed();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const stepCount = Object.values(stepStates).filter((s) => s === "done" || s === "skipped").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            Wrap Up — {booking.booking_number}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {/* Step: Payment — HARD gate */}
          <ChecklistRow
            state={stepStates.payment}
            icon={<IndianRupee className="h-4 w-4" />}
            label="Payment"
            sublabel={(() => {
              switch (booking.payment_status) {
                case "paid":           return `${formatCurrency(Number(booking.total_amount_with_gst) || booking.total_amount)} collected`;
                case "waived":         return "Free quota — waived";
                case "posted_to_bill": return "Settled via monthly invoice";
                case "prepaid":        return "Settled from prepaid pack";
                default:               return "Outstanding — settle before closing";
              }
            })()}
            disableSkip   // HARD gate; skip not allowed
            errorIfPending="Settle payment before closing"
          />

          {/* Step: Internal rating */}
          <ChecklistRow
            state={stepStates.rating}
            icon={<Star className="h-4 w-4" />}
            label="Internal rating"
            sublabel={
              stepStates.rating === "done" ? "Rated"
              : stepStates.rating === "skipped" ? "Skipped — recorded"
              : "Quick rating helps the team learn customer fit"
            }
            actionLabel="Rate now"
            onAction={onOpenRateCustomer}
            onSkip={() => skip("rating")}
            onUnskip={() => unskip("rating")}
          />

          {/* Step: Customer feedback */}
          <ChecklistRow
            state={stepStates.feedback}
            icon={<MessageCircle className="h-4 w-4" />}
            label="Customer feedback link"
            sublabel={
              stepStates.feedback === "done" ? "Feedback received from customer"
              : stepStates.feedback === "skipped" ? "Skipped — recorded"
              : "Email/WhatsApp the customer a feedback link"
            }
            actionLabel="Send"
            onAction={onOpenSendFeedback}
            onSkip={() => skip("feedback")}
            onUnskip={() => unskip("feedback")}
          />

          {/* Step: Outstanding charges from past visits — informational */}
          <ChecklistRow
            state={stepStates.outstanding}
            icon={<ScrollText className="h-4 w-4" />}
            label="Outstanding (past visits)"
            sublabel={
              outstandingCount === 0
                ? "None — clean"
                : `${outstandingCount} unpaid charge${outstandingCount > 1 ? "s" : ""} from earlier bookings`
            }
            disableSkip   // informational only — no skip needed
          />
        </div>

        {/* Notes — optional context the wrap-up audit captures */}
        <div className="space-y-1 mt-3">
          <Label htmlFor="wrapup-notes" className="text-xs">Wrap-up notes (optional)</Label>
          <Textarea
            id="wrapup-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything finance / management should know about this transaction"
            rows={2}
            className="text-sm"
          />
        </div>

        {/* Status line */}
        <div className="flex items-center justify-between mt-3 text-xs">
          <span className="text-muted-foreground">{stepCount}/4 steps handled</span>
          {!allReady && (
            <span className="flex items-center gap-1 text-amber-700">
              <AlertCircle className="h-3.5 w-3.5" />
              Settle payment to enable close
            </span>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={close}
            disabled={submitting || !allReady}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            {submitting
              ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Closing…</>
              : "Mark Closed"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Sub-component ──────────────────────────────────────────────────────────

function ChecklistRow({
  state, icon, label, sublabel, actionLabel, onAction, onSkip, onUnskip, disableSkip,
}: {
  state: StepState;
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  actionLabel?: string;
  onAction?: () => void;
  onSkip?: () => void;
  onUnskip?: () => void;
  disableSkip?: boolean;
  errorIfPending?: string;
}) {
  const stateIcon =
    state === "done"    ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
    : state === "skipped" ? <XCircle className="h-4 w-4 text-muted-foreground" />
    : state === "error" ? <AlertCircle className="h-4 w-4 text-red-600" />
    : <Circle className="h-4 w-4 text-muted-foreground" />;

  return (
    <div className={`flex items-center gap-3 rounded-md border p-2.5 ${
      state === "done" ? "bg-emerald-50/50 border-emerald-200"
      : state === "skipped" ? "bg-muted/30 border-muted opacity-75"
      : "bg-card"
    }`}>
      <div className="shrink-0">{stateIcon}</div>
      <div className="shrink-0 text-muted-foreground">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{sublabel}</div>
      </div>
      {/* Action / skip controls — only for pending / skipped rows */}
      {state === "pending" && (
        <div className="flex gap-1 shrink-0">
          {actionLabel && onAction && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
          {!disableSkip && onSkip && (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={onSkip}>
              Skip
            </Button>
          )}
        </div>
      )}
      {state === "skipped" && onUnskip && (
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onUnskip}>
          Undo skip
        </Button>
      )}
    </div>
  );
}

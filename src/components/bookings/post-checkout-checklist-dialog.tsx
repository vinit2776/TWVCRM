"use client";

/**
 * PostCheckoutChecklistDialog — opt-in reminder of post-checkout
 * housekeeping for a booking. Purely informational — clicking through
 * does NOT change booking state.
 *
 * Originally added in PR 1 as a "Wrap Up" flow that transitioned the
 * booking to a `closed` state. We rolled that back: a booking ending
 * at `checked_out` with payment settled is already a clean terminal
 * signal (no extra status needed). The dialog now exists only to give
 * juniors a guided reminder of optional post-checkout steps:
 *
 *   ✅ Payment       (informational — already enforced on Check Out)
 *   ⬜ Internal rating               [Rate now]
 *   ⬜ Customer feedback              [Send link]
 *   ✅ Outstanding (past visits)     None / N pending
 *
 * No "Mark Closed", no skip-tracking. Staff opens it via the small
 * "Reminders" button on checked-out bookings (and could close it
 * without taking any action).
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2, Circle, Star, MessageCircle, IndianRupee, ScrollText,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { Booking, BookingPayment } from "@/types";

type StepKey = "payment" | "rating" | "feedback" | "outstanding";
type StepState = "done" | "pending";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking: Booking;
  existingPayments: BookingPayment[];
  outstandingCount: number;
  onOpenRateCustomer: () => void;
  onOpenSendFeedback: () => void;
}

export function PostCheckoutChecklistDialog({
  open, onOpenChange, booking, existingPayments, outstandingCount,
  onOpenRateCustomer, onOpenSendFeedback,
}: Props) {
  const [stepStates, setStepStates] = useState<Record<StepKey, StepState>>({
    payment: "pending",
    rating: "pending",
    feedback: "pending",
    outstanding: "pending",
  });

  // Recompute step states each time the dialog opens or the booking
  // data changes. Each step is purely derived from existing fields —
  // no skip toggles, no state to mutate.
  useEffect(() => {
    if (!open) return;
    const SETTLED = new Set(["paid", "waived", "posted_to_bill", "prepaid"]);
    const grandTotal = Number(booking.total_amount_with_gst) || Number(booking.total_amount);
    const paidSoFar = existingPayments
      .filter((p) => p.status === "verified")
      .reduce((s, p) => s + Number(p.amount), 0);
    const paymentSettled = SETTLED.has(booking.payment_status) || paidSoFar + 0.01 >= grandTotal;

    setStepStates({
      payment: paymentSettled ? "done" : "pending",
      rating: booking.feedback ? "done" : "pending",
      feedback: booking.customer_feedback ? "done" : "pending",
      outstanding: outstandingCount === 0 ? "done" : "pending",
    });
  }, [open, booking, existingPayments, outstandingCount]);

  const doneCount = Object.values(stepStates).filter((s) => s === "done").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            Reminders — {booking.booking_number}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Optional housekeeping for after the customer has left. Nothing here changes
          the booking — these are just reminders to help you stay on top of the routine.
        </p>

        <div className="space-y-2 mt-2">
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
                default:               return "Outstanding — collect when possible";
              }
            })()}
          />

          <ChecklistRow
            state={stepStates.rating}
            icon={<Star className="h-4 w-4" />}
            label="Internal rating"
            sublabel={
              stepStates.rating === "done"
                ? "Saved"
                : "Quick rating helps the team learn customer fit"
            }
            actionLabel="Rate now"
            onAction={onOpenRateCustomer}
          />

          <ChecklistRow
            state={stepStates.feedback}
            icon={<MessageCircle className="h-4 w-4" />}
            label="Customer feedback link"
            sublabel={
              stepStates.feedback === "done"
                ? "Feedback received from customer"
                : "Email / WhatsApp the customer a feedback link"
            }
            actionLabel="Send link"
            onAction={onOpenSendFeedback}
          />

          <ChecklistRow
            state={stepStates.outstanding}
            icon={<ScrollText className="h-4 w-4" />}
            label="Outstanding (past visits)"
            sublabel={
              outstandingCount === 0
                ? "None — clean"
                : `${outstandingCount} unpaid charge${outstandingCount > 1 ? "s" : ""} from earlier bookings`
            }
          />
        </div>

        <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
          <span>{doneCount}/4 done</span>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChecklistRow({
  state, icon, label, sublabel, actionLabel, onAction,
}: {
  state: StepState;
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const stateIcon =
    state === "done"
      ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      : <Circle className="h-4 w-4 text-muted-foreground" />;

  return (
    <div className={`flex items-center gap-3 rounded-md border p-2.5 ${
      state === "done" ? "bg-emerald-50/50 border-emerald-200" : "bg-card"
    }`}>
      <div className="shrink-0">{stateIcon}</div>
      <div className="shrink-0 text-muted-foreground">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{sublabel}</div>
      </div>
      {state === "pending" && actionLabel && onAction && (
        <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

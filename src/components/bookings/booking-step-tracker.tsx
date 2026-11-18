"use client";

/**
 * BookingStepTracker — Booked → Paid → Check in → Check out.
 *
 * Gives a new staff member a map of where this booking is, next to the
 * NextActionBanner's "what to do now". Once a confirmed booking is paid it
 * also offers Check In inline, so the step after payment is one click away.
 */

import { Check, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Booking, BookingPayment } from "@/types";

const SETTLED = new Set(["paid", "waived", "prepaid", "posted_to_bill"]);

interface Props {
  booking: Booking;
  payments: BookingPayment[];
  onCheckIn: () => void;
  checkInDisabled?: boolean;
}

export function BookingStepTracker({ booking, payments, onCheckIn, checkInDisabled }: Props) {
  const { status } = booking;
  if (status === "cancelled" || status === "no_show") return null;

  const grandTotal = Number(booking.total_amount_with_gst) || Number(booking.total_amount);
  const paidSoFar = payments
    .filter((p) => p.status === "verified")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const paid = SETTLED.has(booking.payment_status) || paidSoFar + 0.01 >= grandTotal;
  const checkedIn = status === "checked_in" || status === "checked_out";
  const checkedOut = status === "checked_out";

  const steps = [
    { label: "Booked", done: true },
    { label: "Paid", done: paid },
    { label: "Check in", done: checkedIn },
    { label: "Check out", done: checkedOut },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div className="rounded-md border px-3 py-2.5 space-y-2" aria-label="Booking progress">
      <ol className="flex items-center gap-2">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2 flex-1 last:flex-none">
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                s.done
                  ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                  : i === current
                    ? "bg-foreground border-foreground text-background"
                    : "text-muted-foreground"
              }`}
            >
              {s.done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className={`text-xs ${i === current ? "font-medium" : "text-muted-foreground"}`}>
              {s.label}
            </span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-border" />}
          </li>
        ))}
      </ol>
      {status === "confirmed" && paid && (
        <div className="flex items-center justify-between gap-2 rounded bg-emerald-50 px-3 py-2">
          <span className="text-sm text-emerald-800">Payment recorded. Ready to start the session.</span>
          <Button size="sm" onClick={onCheckIn} disabled={checkInDisabled}>
            <LogIn className="mr-1 h-4 w-4" />Check In now
          </Button>
        </div>
      )}
    </div>
  );
}

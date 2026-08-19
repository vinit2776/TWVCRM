"use client";

/**
 * BookingLifecycleTimeline
 *
 * Renders a vertical step-by-step timeline for a single booking, showing every
 * stage from creation through physical check-in / check-out.
 *
 * Lifecycle steps:
 *   1. Booked         — booking_date + start_time determined; confirmed in CRM
 *   2. Session Start  — scheduled start of the slot (booking_date + start_time)
 *   3. ── Physical leg begins ──
 *   4. Checked In     — actual arrival (check_in_at)
 *   5. Checked Out    — actual departure (check_out_at)
 *   or Cancelled / No-Show terminal steps
 *
 * Answers to the user's 5 clarifications:
 *   1. both  — shows for walk-in AND contract customers
 *   2. yes   — timestamps shown for every completed step
 *   3. physical leg — check-in → check-out highlighted as the "physical leg"
 *   4. yes   — includes elapsed time / early-late deltas
 *   5. booking detail page — rendered in the bookings/[id] page
 */

import {
  CalendarCheck, LogIn, LogOut, XCircle, AlertTriangle, Clock,
  CheckCircle2, Circle, IndianRupee, Link2, Sparkles, ScrollText, Gift,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Booking } from "@/types";
import { bookingWindowHours } from "@/lib/utils";

// Currency formatting kept inline to avoid pulling utils into the
// timeline (it's used in a sublabel for the Payment step).
function inr(n: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0 }).format(n);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTs(iso: string): string {
  // Always render in IST. Without an explicit timeZone the runtime falls
  // back to the system tz — Vercel's Node runtime is UTC, so checkout
  // timestamps were displaying 5h30 behind the actual IST time.
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatTime12(timeStr: string): string {
  const [h, m] = timeStr.slice(0, 5).split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function minutesDiff(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

function durationLabel(minutes: number): string {
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

/** Combine booking_date (YYYY-MM-DD) and HH:MM[:SS] into an ISO string */
function slotDateTime(date: string, time: string): string {
  return `${date}T${time.slice(0, 5)}:00`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type StepState = "done" | "active" | "pending" | "cancelled" | "no_show" | "warning";

function StepDot({ state }: { state: StepState }) {
  const base = "flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-full border-2 z-10";
  if (state === "done")
    return (
      <div className={`${base} bg-teal-600 border-teal-600 text-white`}>
        <CheckCircle2 className="h-4 w-4" />
      </div>
    );
  if (state === "active")
    return (
      <div className={`${base} bg-blue-50 border-blue-500 text-blue-600 animate-pulse`}>
        <Circle className="h-3 w-3 fill-blue-500" />
      </div>
    );
  if (state === "warning")
    return (
      <div className={`${base} bg-amber-50 border-amber-400 text-amber-600`}>
        <AlertTriangle className="h-4 w-4" />
      </div>
    );
  if (state === "cancelled")
    return (
      <div className={`${base} bg-red-50 border-red-400 text-red-500`}>
        <XCircle className="h-4 w-4" />
      </div>
    );
  if (state === "no_show")
    return (
      <div className={`${base} bg-amber-50 border-amber-400 text-amber-600`}>
        <AlertTriangle className="h-4 w-4" />
      </div>
    );
  // pending
  return (
    <div className={`${base} bg-background border-muted-foreground/30 text-muted-foreground/40`}>
      <Circle className="h-3 w-3" />
    </div>
  );
}

function ConnectorLine({ done, highlight }: { done: boolean; highlight?: boolean }) {
  return (
    <div className="flex flex-col items-center w-8 flex-shrink-0 my-[-2px]">
      <div
        className={[
          "w-0.5 h-6",
          done
            ? highlight
              ? "bg-blue-400"
              : "bg-teal-400"
            : "border-l-2 border-dashed border-muted-foreground/20",
        ].join(" ")}
      />
    </div>
  );
}

interface StepProps {
  state: StepState;
  icon: React.ReactNode;
  label: string;
  timestamp?: string;
  sublabel?: string;
  badge?: React.ReactNode;
  isLast?: boolean;
  highlight?: boolean; // physical leg styling
  actorName?: string | null; // who performed this action
}

function Step({ state, icon, label, timestamp, sublabel, badge, isLast, highlight, actorName }: StepProps) {
  const isPending = state === "pending";
  return (
    <div className="flex items-start gap-0">
      <div className="flex flex-col items-center">
        <StepDot state={state} />
        {!isLast && <ConnectorLine done={state === "done" || state === "active"} highlight={highlight} />}
      </div>
      <div
        className={[
          "ml-3 pb-5 flex-1 min-w-0",
          isPending ? "opacity-40" : "",
          isLast ? "pb-0" : "",
        ].join(" ")}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={[
              "text-sm font-semibold flex items-center gap-1.5",
              highlight ? "text-blue-700" : "text-foreground",
            ].join(" ")}
          >
            <span className={highlight ? "text-blue-500" : "text-muted-foreground"}>
              {icon}
            </span>
            {label}
          </span>
          {badge}
        </div>
        {(timestamp || actorName) && (
          <p className={`text-xs mt-0.5 ${highlight ? "text-blue-600" : "text-muted-foreground"}`}>
            {timestamp}
            {actorName && (
              <span className="text-muted-foreground font-normal">{timestamp ? " · " : ""}by {actorName}</span>
            )}
          </p>
        )}
        {sublabel && (
          <p className="text-xs text-muted-foreground mt-0.5">{sublabel}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comp request types
// ---------------------------------------------------------------------------

export interface CompRequestData {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  reason: string | null;
  metadata: {
    requested_by_name?: string;
    reason_label?: string;
    details?: string;
    [key: string]: unknown;
  };
  rejection_reason: string | null;
  requested_by: string;
  created_at: string;
  expires_at: string | null;
  acted_at: string | null;
  requester?: { id: string; full_name: string } | null;
  actor?: { id: string; full_name: string } | null;
}

function timeLeft(iso: string): string {
  const diff = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (diff <= 0) return "expired";
  if (diff < 3600) return `${Math.floor(diff / 60)}m remaining`;
  return `${Math.floor(diff / 3600)}h remaining`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Human label for how long the booking runs.
 *
 * Deliberately derived from start_time/end_time rather than
 * `bookings.duration_hours`: for daily-priced spaces that column stores "1"
 * as a billing day-unit, not one hour, so a 9am–7pm day pass used to render
 * as "1h slot". `duration_hours` stays untouched — billing, contract
 * free-quota and utilisation analytics all depend on the day-unit meaning.
 */
function slotDurationLabel(booking: Booking): string {
  const hours = bookingWindowHours(booking.start_time, booking.end_time);
  // Trim float noise from minute-level windows (1.5 → "1.5", 2.0 → "2").
  const pretty = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(/\.0$/, "");
  return booking.pricing_model === "daily" ? `${pretty}h day pass` : `${pretty}h slot`;
}

interface BookingLifecycleTimelineProps {
  booking: Booking;
  compRequest?: CompRequestData | null;
}

export function BookingLifecycleTimeline({ booking, compRequest }: BookingLifecycleTimelineProps) {
  const status = booking.status;
  const scheduledStart = slotDateTime(booking.booking_date, booking.start_time);
  const scheduledEnd   = slotDateTime(booking.booking_date, booking.end_time);

  // ── Step states ───────────────────────────────────────────────────────────
  // Step 1: Booked — always done once we're looking at a booking
  const step1State: StepState = "done";

  // Step 1.5: Payment — derived from booking.payment_status. The states
  // map to the user's mental model of "where is the money?":
  //   paid / prepaid / waived / posted_to_bill → done (each with a
  //                                                   different sublabel)
  //   pending + razorpay_payment_link_id        → active ("link sent")
  //   pending                                   → pending
  //   cancelled booking                         → done (refund out of scope)
  const paymentState: StepState = (() => {
    if (status === "cancelled") return "done";
    switch (booking.payment_status) {
      case "paid":
      case "prepaid":
      case "waived":
      case "posted_to_bill":
        return "done";
      case "pending":
      default:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (booking as any).razorpay_payment_link_id ? "active" : "pending";
    }
  })();
  const totalDue = Number(booking.total_amount_with_gst) || Number(booking.total_amount);
  const paymentLabel = (() => {
    switch (booking.payment_status) {
      case "paid":           return "Payment Received";
      case "prepaid":        return "Paid via Prepaid Pack";
      case "waived": {
        // Complimentary bookings (manually marked ₹0) show a different label
        // than quota-based waivers (auto-waived within contract hour quota).
        if (booking.complimentary_reason) return "Complimentary — No charge";
        return "Free Quota — Waived";
      }
      case "posted_to_bill": return "Post-paid (Monthly Invoice)";
      case "pending":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      default:               return (booking as any).razorpay_payment_link_id
        ? "Payment Link Sent — Awaiting Customer"
        : "Payment Pending";
    }
  })();
  const paymentSublabel = (() => {
    switch (booking.payment_status) {
      case "paid": {
        const mode = booking.payment_mode;
        const label = mode === "cash" ? "cash" : mode === "upi" ? "UPI" : mode === "card" ? "card" : mode === "razorpay" ? "Razorpay" : "online";
        return `${inr(totalDue)} collected via ${label}`;
      }
      case "prepaid":        return `${inr(totalDue)} settled from prepaid pack`;
      case "waived": {
        // Complimentary booking — show the reason
        if (booking.complimentary_reason) {
          const reasonLabels: Record<string, string> = {
            client_complimentary: "Client complimentary",
            staff_use: "Staff use",
            maintenance: "Maintenance / testing",
            promotional: "Promotional",
            other: "Other",
          };
          const label = reasonLabels[booking.complimentary_reason] || booking.complimentary_reason;
          const detail = booking.complimentary_details ? `: ${booking.complimentary_details}` : "";
          return `${label}${detail}`;
        }
        // Quota-based waiver — show quota usage if available
        const q = booking.quota_info;
        if (q) {
          return `Quota: ${q.used_this_month}hr used of ${q.monthly_quota}hr/mo · ${q.remaining_after}hr remaining`;
        }
        return `Within free-quota allowance — no charge`;
      }
      case "posted_to_bill": return `${inr(totalDue)} will appear on the next monthly invoice`;
      case "pending":
      default:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (booking as any).razorpay_payment_link_id
          ? `${inr(totalDue)} due — customer has the payment link`
          : `${inr(totalDue)} due — collect at counter or send link`;
    }
  })();
  const paymentIcon = (() => {
    switch (booking.payment_status) {
      case "paid":           return <IndianRupee className="h-3.5 w-3.5" />;
      case "prepaid":        return <Sparkles className="h-3.5 w-3.5" />;
      case "waived":         return <CheckCircle2 className="h-3.5 w-3.5" />;
      case "posted_to_bill": return <ScrollText className="h-3.5 w-3.5" />;
      case "pending":
      default:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (booking as any).razorpay_payment_link_id
          ? <Link2 className="h-3.5 w-3.5" />
          : <IndianRupee className="h-3.5 w-3.5" />;
    }
  })();

  // Step 2: Session Start — done if we've passed it
  const now = new Date();
  const slotStarted = now >= new Date(scheduledStart);
  const step2State: StepState =
    status === "cancelled" || status === "no_show"
      ? "done"
      : slotStarted || status === "checked_in" || status === "checked_out"
      ? "done"
      : "pending";

  // Step 3: Check-in
  const step3State: StepState =
    status === "cancelled"
      ? "cancelled"
      : status === "no_show"
      ? "no_show"
      : status === "checked_in"
      ? "active"
      : booking.check_in_at
      ? "done"
      : "pending";

  // Step 4: Check-out (only if we have check-in)
  const step4State: StepState =
    status === "cancelled" || status === "no_show"
      ? "pending"
      : status === "checked_out" && booking.check_out_at
      ? "done"
      : status === "checked_in"
      ? "pending"
      : "pending";

  // ── Physical leg timing ───────────────────────────────────────────────────
  let checkInDeltaLabel: React.ReactNode = null;
  if (booking.check_in_at) {
    const delta = minutesDiff(scheduledStart, booking.check_in_at);
    if (delta > 2) {
      checkInDeltaLabel = (
        <Badge variant="secondary" className="bg-amber-100 text-amber-700 text-[10px] font-normal">
          {durationLabel(delta)} late
        </Badge>
      );
    } else if (delta < -2) {
      checkInDeltaLabel = (
        <Badge variant="secondary" className="bg-green-100 text-green-700 text-[10px] font-normal">
          {durationLabel(delta)} early
        </Badge>
      );
    }
  }

  let checkOutDeltaLabel: React.ReactNode = null;
  let actualDurationLabel: string | null = null;
  if (booking.check_out_at) {
    const delta = minutesDiff(scheduledEnd, booking.check_out_at);
    if (delta > 5) {
      checkOutDeltaLabel = (
        <Badge variant="secondary" className="bg-red-100 text-red-700 text-[10px] font-normal">
          {durationLabel(delta)} over
        </Badge>
      );
    } else if (delta < -5) {
      checkOutDeltaLabel = (
        <Badge variant="secondary" className="bg-blue-100 text-blue-700 text-[10px] font-normal">
          {durationLabel(delta)} early
        </Badge>
      );
    }

    if (booking.check_in_at) {
      const actualMins = minutesDiff(booking.check_in_at, booking.check_out_at);
      actualDurationLabel = `Physical session: ${durationLabel(actualMins)}`;
    }
  }

  // Physical leg is highlighted when checked_in or checked_out
  const physicalLegActive =
    status === "checked_in" || status === "checked_out";

  return (
    <div className="py-1">
      {/* Step 1: Booked */}
      <Step
        state={step1State}
        icon={<CalendarCheck className="h-3.5 w-3.5" />}
        label="Booked"
        timestamp={formatTs(booking.created_at)}
        sublabel={`${formatTime12(booking.start_time)} – ${formatTime12(booking.end_time)} · ${slotDurationLabel(booking)}`}
        actorName={booking.created_by_name}
      />

      {/* Step 1.5a: Comp approval request — only shown when a comp request
          exists. Sits between "Booked" and "Payment" to explain WHY the
          payment state is in limbo. Shows current status with enough
          context for staff to know what to do next. */}
      {compRequest && (() => {
        const cr = compRequest;
        const meta = cr.metadata || {};
        const requesterName =
          (cr.requester as { full_name?: string } | null)?.full_name
          ?? meta.requested_by_name
          ?? "Unknown";
        const actorName = (cr.actor as { full_name?: string } | null)?.full_name;
        const reasonLabel = meta.reason_label ?? cr.reason ?? "";

        const compStepState: StepState =
          cr.status === "approved"  ? "done"    :
          cr.status === "pending"   ? "active"  :
          cr.status === "rejected"  ? "warning" :
          /* expired */               "warning";

        const compLabel =
          cr.status === "approved" ? "Comp Approved" :
          cr.status === "pending"  ? "Comp Approval Pending" :
          cr.status === "rejected" ? "Comp Request Rejected" :
          "Comp Request Expired";

        const compTimestamp =
          cr.status === "approved" && cr.acted_at ? formatTs(cr.acted_at) :
          cr.status === "rejected" && cr.acted_at ? formatTs(cr.acted_at) :
          cr.status === "pending"  ? `Submitted ${formatTs(cr.created_at)}` :
          `Expired ${cr.acted_at ? formatTs(cr.acted_at) : formatTs(cr.created_at)}`;

        const compSublabel = (() => {
          if (cr.status === "pending") {
            const remaining = cr.expires_at ? ` · ${timeLeft(cr.expires_at)}` : "";
            return `Requested by ${requesterName}${remaining} — managers notified`;
          }
          if (cr.status === "approved") {
            return `Approved by ${actorName ?? "a manager"} · Booking marked complimentary`;
          }
          if (cr.status === "rejected") {
            const reason = cr.rejection_reason ? `: "${cr.rejection_reason}"` : "";
            return `Rejected by ${actorName ?? "a manager"}${reason} · Re-submit or collect payment`;
          }
          // expired
          return `Request not reviewed in time — re-submit from the booking actions if still needed`;
        })();

        const compBadge = cr.status === "pending" ? (
          <Badge variant="secondary" className="bg-amber-100 text-amber-700 text-[10px] font-normal animate-pulse">
            Awaiting review
          </Badge>
        ) : cr.status === "rejected" ? (
          <Badge variant="secondary" className="bg-red-100 text-red-700 text-[10px] font-normal">
            Action required
          </Badge>
        ) : cr.status === "expired" ? (
          <Badge variant="secondary" className="bg-slate-100 text-slate-600 text-[10px] font-normal">
            Re-submit if needed
          </Badge>
        ) : null;

        return (
          <Step
            state={compStepState}
            icon={<Gift className="h-3.5 w-3.5" />}
            label={compLabel}
            timestamp={compTimestamp}
            sublabel={compSublabel}
            badge={compBadge}
          />
        );
      })()}

      {/* Step 1.5: Payment — surfaces "where is the money" in plain
          language. Pending/link-sent vs paid vs prepaid vs waived vs
          posted-to-monthly-bill all read distinctly so finance/staff can
          tell the state at a glance without leaving the lifecycle. */}
      <Step
        state={paymentState}
        icon={paymentIcon}
        label={paymentLabel}
        timestamp={
          booking.payment_status === "paid"
            ? formatTs(booking.updated_at)
            : paymentState === "active"
              ? "Sent — waiting for customer"
              : paymentState === "pending"
                ? "Awaiting collection"
                : undefined
        }
        sublabel={paymentSublabel}
        highlight={paymentState === "active"}
        actorName={booking.payment_status === "waived" ? booking.created_by_name : undefined}
      />

      {/* Step 2: Session Scheduled */}
      <Step
        state={step2State}
        icon={<Clock className="h-3.5 w-3.5" />}
        label="Session Start"
        timestamp={
          step2State === "pending"
            ? `Scheduled ${formatTs(scheduledStart)}`
            : formatTs(scheduledStart)
        }
        sublabel={
          step2State !== "pending" && !booking.check_in_at
            ? "Waiting for physical arrival"
            : undefined
        }
      />

      {/* Step 3: Checked In — physical leg */}
      {status !== "cancelled" && (
        <Step
          state={step3State}
          icon={<LogIn className="h-3.5 w-3.5" />}
          label={
            step3State === "no_show"
              ? "No-Show"
              : step3State === "active"
              ? "Checked In — Session in progress"
              : "Checked In"
          }
          timestamp={
            booking.no_show_detected_at && step3State === "no_show"
              ? formatTs(booking.no_show_detected_at)
              : booking.check_in_at
              ? formatTs(booking.check_in_at)
              : "Awaiting arrival"
          }
          sublabel={
            step3State === "no_show"
              ? "Customer did not arrive — no-show policy applied"
              : step3State === "active"
              ? `Physical leg in progress · scheduled end ${formatTime12(booking.end_time)}`
              : undefined
          }
          badge={checkInDeltaLabel}
          highlight={physicalLegActive && step3State !== "no_show"}
          actorName={booking.check_in_at ? booking.checked_in_by_name : undefined}
        />
      )}

      {/* Cancelled terminal step */}
      {status === "cancelled" && (
        <Step
          state="cancelled"
          icon={<XCircle className="h-3.5 w-3.5" />}
          label="Cancelled"
          timestamp={formatTs(booking.updated_at)}
          actorName={booking.cancelled_by_name}
          isLast
        />
      )}

      {/* Step 4: Checked Out — physical leg end (terminal) */}
      {status !== "cancelled" && status !== "no_show" && (
        <Step
          state={step4State}
          icon={<LogOut className="h-3.5 w-3.5" />}
          label="Checked Out"
          timestamp={
            booking.check_out_at
              ? formatTs(booking.check_out_at)
              : step3State === "active"
              ? `Scheduled ${formatTime12(booking.end_time)}`
              : "Awaiting checkout"
          }
          sublabel={actualDurationLabel || undefined}
          badge={checkOutDeltaLabel}
          highlight={physicalLegActive}
          actorName={booking.check_out_at ? booking.checked_out_by_name : undefined}
          isLast
        />
      )}

      {/* No-show is terminal after step 3 */}
      {status === "no_show" && (
        <div className="ml-[44px] text-xs text-muted-foreground mt-[-12px] mb-2">
          No further action required unless a refund exception was raised.
        </div>
      )}
    </div>
  );
}

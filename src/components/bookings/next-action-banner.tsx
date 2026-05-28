"use client";

/**
 * NextActionBanner — derives the canonical "next step" for a booking
 * from its current state and surfaces it as a single guided hint above
 * the action button row.
 *
 * Goal: a junior staff member should be able to open any booking and
 * know what to do without memorising the full state machine. Veterans
 * can ignore the banner — the action buttons remain.
 *
 * Decision tree (top to bottom; first match wins):
 *   booking is closed              → "All done — closed."
 *   booking is cancelled / no_show → "Terminal state — wrap up if needed."
 *   booking is checked_out         → "Wrap Up to close this transaction."
 *   booking is checked_in          → ──┐
 *                                       (overtime detected) → "Customer is over their booked time. Add Extended Time charge."
 *                                       (otherwise)         → "Session in progress. Check Out when ready."
 *   booking is confirmed           → ──┐
 *                                       (unpaid + walk-in)  → "Collect ₹X before check-in."
 *                                       (unpaid + others)   → "Collect ₹X or check in to start the session."
 *                                       (paid)              → "Check the customer in."
 *
 * Exists separately from the action buttons (which always show every
 * available action) so the banner is a HINT, not a replacement.
 */

import { ArrowRight, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { Booking, BookingPayment } from "@/types";
import type { CompRequestData } from "@/components/bookings/booking-lifecycle-timeline";

interface Props {
  booking: Booking;
  existingPayments: BookingPayment[];
  compRequest?: CompRequestData | null;
}

export function NextActionBanner({ booking, existingPayments, compRequest }: Props) {
  const hint = computeNextHint(booking, existingPayments, compRequest);
  if (!hint) return null;

  // Tone styles — green for "done", amber for action needed, slate for terminal/info.
  const tone = hint.tone;
  const styles = {
    green:  "bg-emerald-50 border-emerald-200 text-emerald-900",
    amber:  "bg-amber-50 border-amber-300 text-amber-900",
    slate:  "bg-slate-50 border-slate-200 text-slate-700",
    blue:   "bg-blue-50 border-blue-200 text-blue-900",
  }[tone];

  const Icon =
    tone === "green" ? CheckCircle2 :
    tone === "amber" ? AlertCircle  :
    hint.clock      ? Clock         :
    ArrowRight;

  return (
    <div className={`rounded-md border-l-4 px-3 py-2 flex items-center gap-2 ${styles}`}>
      <Icon className="h-4 w-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{hint.label}</div>
        {hint.detail && <div className="text-[11px] opacity-80 mt-0.5">{hint.detail}</div>}
      </div>
    </div>
  );
}

/**
 * Identifies which UI region should carry the pulsing halo. Wrap that
 * region with <NextActionTarget id="..."> in the booking detail page.
 * Exactly ONE region lights up at a time — derived from the same logic
 * as the textual banner so they always agree.
 */
export type NextActionTargetId =
  | "actions"          // header action button row (Check In / Check Out / Wrap Up etc.)
  | "collect_payment"  // the Collect Payment button + pricing card
  | "add_charges"      // the Extras & charges section
  | null;

interface Hint {
  label: string;
  detail?: string;
  tone: "green" | "amber" | "slate" | "blue";
  target: NextActionTargetId;
  clock?: boolean; // use Clock icon instead of Arrow
}

export function computeNextActionTarget(b: Booking, payments: BookingPayment[], compRequest?: CompRequestData | null): NextActionTargetId {
  return computeNextHint(b, payments, compRequest)?.target ?? null;
}

function computeNextHint(b: Booking, payments: BookingPayment[], compRequest?: CompRequestData | null): Hint | null {
  const status = b.status;

  // ── Comp request state — takes priority over generic payment hints
  // so staff always knows WHY the booking is in limbo. ────────────────────
  if (compRequest && compRequest.status === "pending" && b.payment_status !== "waived") {
    const meta = compRequest.metadata || {};
    const requesterName =
      (compRequest.requester as { full_name?: string } | null)?.full_name
      ?? meta.requested_by_name
      ?? "a floor manager";
    const timeRemaining = compRequest.expires_at
      ? (() => {
          const diff = Math.floor((new Date(compRequest.expires_at).getTime() - Date.now()) / 1000);
          if (diff <= 0) return null;
          if (diff < 3600) return `${Math.floor(diff / 60)}m`;
          return `${Math.floor(diff / 3600)}h`;
        })()
      : null;

    return {
      label: "Comp approval pending — payment on hold",
      detail: `${requesterName} requested this booking be complimentary. A manager needs to approve or reject from the Approvals bell${timeRemaining ? ` · ${timeRemaining} left to decide` : ""}.`,
      tone: "amber",
      target: null,
      clock: true,
    };
  }

  if (compRequest && compRequest.status === "rejected" && b.payment_status !== "waived") {
    const meta = compRequest.metadata || {};
    const actorName = (compRequest.actor as { full_name?: string } | null)?.full_name ?? "a manager";
    const rejectionNote = compRequest.rejection_reason ? `: "${compRequest.rejection_reason}"` : "";
    const requesterName =
      (compRequest.requester as { full_name?: string } | null)?.full_name
      ?? meta.requested_by_name
      ?? null;
    return {
      label: "Comp request rejected — payment still due",
      detail: `Rejected by ${actorName}${rejectionNote}. ${requesterName ? `${requesterName} can re-submit, or` : "You can"} collect payment normally.`,
      tone: "amber",
      target: "collect_payment",
    };
  }

  if (compRequest && compRequest.status === "expired" && b.payment_status !== "waived") {
    const meta = compRequest.metadata || {};
    const requesterName =
      (compRequest.requester as { full_name?: string } | null)?.full_name
      ?? meta.requested_by_name
      ?? null;
    return {
      label: "Comp request expired — payment still due",
      detail: `The approval window passed without a decision. ${requesterName ? `${requesterName} can re-submit, or` : ""} collect payment normally.`,
      tone: "amber",
      target: "collect_payment",
    };
  }

  // Terminal: cancelled / no_show. Calm — booking is recorded, no
  // further action expected from staff.
  if (status === "cancelled" || status === "no_show") {
    return {
      label: status === "cancelled" ? "Booking cancelled" : "Marked as no-show",
      detail: "Recorded — no further action needed",
      tone: "slate",
      target: null,
    };
  }

  // checked_out → either finish the payment or send the optional
  // post-checkout reminders (rating + feedback). Once both rating and
  // feedback are handled (or skipped), the page goes calm.
  if (status === "checked_out") {
    const SETTLED = new Set(["paid", "waived", "posted_to_bill", "prepaid"]);
    const grandTotal = Number(b.total_amount_with_gst) || Number(b.total_amount);
    const paidSoFar = payments
      .filter((p) => p.status === "verified")
      .reduce((s, p) => s + Number(p.amount), 0);
    const settled = SETTLED.has(b.payment_status) || paidSoFar + 0.01 >= grandTotal;
    if (!settled) {
      const balance = grandTotal - paidSoFar;
      return {
        label: `Collect ${formatCurrency(balance)} balance`,
        detail: "Customer has checked out but payment is still due",
        tone: "amber",
        target: "collect_payment",
      };
    }
    // Payment is settled. If rating + feedback are still pending,
    // suggest the reminders. Otherwise the page is calm.
    if (!b.feedback || !b.customer_feedback) {
      return {
        label: "Booking complete",
        detail: "When you have a moment — rate the customer and send a feedback link",
        tone: "blue",
        target: null,
      };
    }
    return {
      label: "All done",
      detail: "Rating saved and customer feedback received",
      tone: "green",
      target: null,
    };
  }

  // checked_in → session in progress; check out when ready. We don't
  // highlight anything aggressively while in-session — the staff is
  // mid-interaction with the customer and the eye should stay where it
  // already is. The Check Out button is in the action row but doesn't
  // need a halo.
  if (status === "checked_in") {
    return {
      label: "Session in progress",
      detail: "Add charges if needed, Check Out when the customer is done",
      tone: "blue",
      target: null,
    };
  }

  // confirmed → either collect payment or check in
  if (status === "confirmed") {
    const SETTLED = new Set(["paid", "waived", "posted_to_bill", "prepaid"]);
    const grandTotal = Number(b.total_amount_with_gst) || Number(b.total_amount);
    const paidSoFar = payments
      .filter((p) => p.status === "verified")
      .reduce((s, p) => s + Number(p.amount), 0);
    const settled = SETTLED.has(b.payment_status) || paidSoFar + 0.01 >= grandTotal;

    if (!settled) {
      const balance = grandTotal - paidSoFar;
      const isWalkIn = b.customer_type === "walk_in";
      return {
        label: `Collect ${formatCurrency(balance)}`,
        detail: isWalkIn
          ? "Walk-in must be paid before check-in"
          : "Collect now or check in to start the session",
        tone: "amber",
        target: "collect_payment",
      };
    }
    return {
      label: "Check the customer in",
      detail: "Payment received — ready to start the session",
      tone: "blue",
      target: "actions",
    };
  }

  return null;
}

// ── NextActionTarget wrapper ─────────────────────────────────────────────────
//
// Lights up its child container with a soft amber pulse halo when its
// `id` matches the current target derived by computeNextActionTarget.
// Exactly one target is "live" at a time (enforced by the parent
// passing a single `currentTarget` value). Cross-fade is handled by the
// .next-action-pulse CSS class transition; un-highlighted state has
// zero box-shadow so removal is instant + smooth.

interface TargetProps {
  /** Stable identifier — must match one of NextActionTargetId */
  id: NonNullable<NextActionTargetId>;
  /** The currently-active target from computeNextActionTarget */
  currentTarget: NextActionTargetId;
  children: React.ReactNode;
  className?: string;
}

export function NextActionTarget({ id, currentTarget, children, className = "" }: TargetProps) {
  const isActive = currentTarget === id;
  return (
    <div
      data-next-action-target={id}
      data-next-action-active={isActive ? "true" : "false"}
      className={isActive ? `next-action-pulse ${className}`.trim() : className}
    >
      {children}
    </div>
  );
}

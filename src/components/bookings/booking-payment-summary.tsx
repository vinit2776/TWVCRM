"use client";

/**
 * Booking Payment Summary — compact, finance-friendly status block.
 *
 * Replaces the bare "posted_to_bill" pill with a full-context summary that
 * tells finance everything they need at a glance:
 *   - what the customer owes
 *   - how it'll be settled (counter, monthly invoice, prepaid pack, free quota)
 *   - method + reference if already collected
 *   - link to the related contract / monthly statement when applicable
 *
 * Designed to render in two places:
 *   - Booking detail page (variant="full") — banner above the price card
 *   - Billing list rows (variant="inline") — single-line summary in a cell
 */

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Banknote, ScrollText, ExternalLink, IndianRupee, CalendarClock,
  CheckCircle2, AlertCircle, Wallet, Sparkles, ImageIcon, Loader2,
} from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import type { Booking, BookingPayment } from "@/types";

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

interface Props {
  booking: Pick<Booking,
    | "id" | "booking_number" | "booking_date" | "customer_type"
    | "payment_status" | "payment_mode" | "payment_reference"
    | "total_amount" | "total_amount_with_gst"
    | "contract_id" | "prepaid_purchase_id" | "prepaid_credits_used"
    | "complimentary_reason" | "complimentary_details"
  > & {
    contract?: { id: string; contract_number: string } | null;
  };
  /** When true (booking detail), render the full multi-line banner.
   *  When false (list rows), render a single-line inline summary. */
  variant?: "full" | "inline";
  /** Payment records for this booking — used to surface a "View screenshot"
   *  action for the UPI proof-of-payment, without another fetch. */
  payments?: BookingPayment[];
  onViewScreenshot?: (paymentId: string, screenshotPath: string) => void;
  loadingScreenshotId?: string | null;
}

export function BookingPaymentSummary({ booking, variant = "full", payments, onViewScreenshot, loadingScreenshotId }: Props) {
  const total = Number(booking.total_amount_with_gst || booking.total_amount || 0);
  const screenshotPayment = payments
    ?.filter((p) => p.payment_mode === "upi" && p.screenshot_path)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null;

  // Derive a single, finance-readable shape from the booking row.
  const summary = (() => {
    // Prepaid takes priority — even contract holders sometimes use a prepaid pack
    if (booking.payment_status === "prepaid" || booking.prepaid_purchase_id) {
      return {
        kind: "prepaid" as const,
        title: "Prepaid Pack",
        sub: booking.prepaid_credits_used
          ? `${Number(booking.prepaid_credits_used)} credits used`
          : "Settled from prepaid pack",
        tone: "purple",
        icon: Sparkles,
      };
    }

    if (booking.payment_status === "waived") {
      // A waived booking can mean two distinct things:
      //   - Complimentary (staff comp, ₹0 booking) — has
      //     complimentary_reason set
      //   - Free quota (contract member's monthly allowance) — no
      //     complimentary fields set; legacy waiver path
      // Surface the difference so finance can see which is which.
      if (booking.complimentary_reason) {
        const REASON_LABELS: Record<string, string> = {
          manager_goodwill:   "Manager goodwill",
          aggregator_demo:    "Aggregator demo",
          staff_use:          "Staff use",
          event_partnership:  "Event partnership",
          other:              "Other",
        };
        const label = REASON_LABELS[booking.complimentary_reason] || booking.complimentary_reason;
        return {
          kind: "waived" as const,
          title: "Complimentary — No charge",
          sub: booking.complimentary_details
            ? `${label}: ${booking.complimentary_details}`
            : label,
          tone: "slate",
          icon: CheckCircle2,
        };
      }
      return {
        kind: "waived" as const,
        title: "Free Quota — No charge",
        sub: "Within monthly free-quota allowance",
        tone: "slate",
        icon: CheckCircle2,
      };
    }

    if (booking.payment_status === "paid") {
      const modeLabel = (() => {
        switch (booking.payment_mode) {
          case "cash":     return "Cash";
          case "upi":      return "UPI";
          case "card":     return "Card";
          case "razorpay": return "Online (Razorpay)";
          default:         return booking.payment_mode || "Collected";
        }
      })();
      return {
        kind: "paid" as const,
        title: `Paid via ${modeLabel}`,
        sub: booking.payment_reference
          ? `Ref: ${booking.payment_reference}`
          : `${formatCurrency(total)} collected`,
        tone: "green",
        icon: CheckCircle2,
      };
    }

    if (booking.payment_status === "posted_to_bill") {
      // Pull invoice month from the booking date (per current logic, the
      // booking goes onto that calendar month's invoice for the contract).
      const d = new Date(booking.booking_date + "T00:00:00");
      const month = `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`;
      return {
        kind: "posted" as const,
        title: "Post-paid — Monthly Invoice",
        sub: `Will appear on ${month} invoice${booking.contract?.contract_number ? ` for ${booking.contract.contract_number}` : ""}`,
        tone: "blue",
        icon: CalendarClock,
      };
    }

    // Default: pending
    if (booking.customer_type === "contract_holder") {
      return {
        kind: "pending" as const,
        title: "Pending — Awaiting decision",
        sub: "Contract holder — choose to post to monthly invoice or collect now",
        tone: "amber",
        icon: AlertCircle,
      };
    }
    return {
      kind: "pending" as const,
      title: "Pending Collection",
      sub: `${formatCurrency(total)} due — collect at counter`,
      tone: "amber",
      icon: AlertCircle,
    };
  })();

  // Tailwind colour pools per tone — kept here so the rest of the app can
  // adopt the same colour standard later (Phase 3 of the finance refactor).
  const tones = {
    green:  { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700" },
    blue:   { bg: "bg-blue-50",    border: "border-blue-200",    text: "text-blue-700" },
    amber:  { bg: "bg-amber-50",   border: "border-amber-200",   text: "text-amber-700" },
    purple: { bg: "bg-purple-50",  border: "border-purple-200",  text: "text-purple-700" },
    slate:  { bg: "bg-slate-50",   border: "border-slate-200",   text: "text-slate-700" },
  } as const;
  const tone = tones[summary.tone as keyof typeof tones];
  const Icon = summary.icon;

  if (variant === "inline") {
    // Single-line for table rows
    return (
      <div className={cn("inline-flex items-center gap-1.5 text-xs", tone.text)}>
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{summary.title}</span>
        {booking.contract?.contract_number && summary.kind === "posted" && (
          <Link
            href={`/contracts/${booking.contract.id}`}
            target="_blank"
            rel="noopener"
            className="font-mono text-[10px] underline opacity-80 hover:opacity-100"
          >{booking.contract.contract_number}</Link>
        )}
      </div>
    );
  }

  // Full banner for booking detail page
  return (
    <div className={cn("rounded-lg border p-4", tone.bg, tone.border)}>
      <div className="flex items-start gap-3">
        <Icon className={cn("h-5 w-5 shrink-0 mt-0.5", tone.text)} />
        <div className="flex-1 min-w-0">
          <div className={cn("text-sm font-semibold flex items-center gap-2 flex-wrap", tone.text)}>
            <span>{summary.title}</span>
            <Badge variant="outline" className={cn("text-[10px]", tone.text, tone.border)}>
              {formatCurrency(total)}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground mt-1">{summary.sub}</div>

          {summary.kind === "paid" && screenshotPayment && onViewScreenshot && (
            <button
              type="button"
              className={cn("inline-flex items-center gap-1 text-xs font-medium mt-2 hover:underline underline-offset-2", tone.text)}
              onClick={() => onViewScreenshot(screenshotPayment.id, screenshotPayment.screenshot_path!)}
              disabled={loadingScreenshotId === screenshotPayment.id}
            >
              {loadingScreenshotId === screenshotPayment.id ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ImageIcon className="h-3 w-3" />
              )}
              View payment screenshot
            </button>
          )}

          {/* Deep links — when the booking is post-paid, show the contract
              link so finance can jump straight to its monthly statement. */}
          {summary.kind === "posted" && booking.contract && (
            <div className="flex items-center gap-1 mt-2">
              <Link
                href={`/contracts/${booking.contract.id}`}
                target="_blank"
                rel="noopener"
                className={cn("inline-flex items-center gap-1 text-xs font-medium hover:underline", tone.text)}
              >
                <ScrollText className="h-3 w-3" />
                {booking.contract.contract_number}
                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Re-export icon helpers for callers that want to mix-and-match
export const PAYMENT_TONE_ICONS = { Banknote, Wallet, IndianRupee };

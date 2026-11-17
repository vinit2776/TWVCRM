"use client";

/**
 * BookingPiSentBanner — the visible confirmation that a PI and its payment link
 * went out: when, to whom, by whom, and where the payment stands. It stays on the
 * booking after payment, so staff can always see a PI was sent.
 */

import { Button } from "@/components/ui/button";
import { CheckCircle2, Send } from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface Props {
  sentAt: string;
  sentTo: string | null;
  sentByName: string | null;
  paymentStatus: string;
  /** Opens the Send PI dialog again; omitted once the booking is settled. */
  onResend?: () => void;
}

export function BookingPiSentBanner({ sentAt, sentTo, sentByName, paymentStatus, onResend }: Props) {
  const paid = paymentStatus === "paid";
  const settled = paid || ["waived", "prepaid", "posted_to_bill"].includes(paymentStatus);
  const tone = paid
    ? "bg-emerald-50 border-emerald-200 text-emerald-700"
    : "bg-blue-50 border-blue-200 text-blue-700";
  const Icon = paid ? CheckCircle2 : Send;

  return (
    <div className={`rounded-lg border p-3 flex items-start gap-3 ${tone}`}>
      <Icon className="h-5 w-5 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">PI and payment link sent · {formatDateTime(sentAt)}</div>
        <div className="text-xs mt-0.5 opacity-90">
          {[sentTo ? `to ${sentTo}` : null, sentByName ? `by ${sentByName}` : null].filter(Boolean).join(" · ")}
          {paid
            ? " · Paid"
            : settled
              ? ""
              : " · Awaiting payment. This updates by itself when the customer pays."}
        </div>
      </div>
      {onResend && !settled && (
        <Button variant="outline" size="sm" className="shrink-0 bg-white/70" onClick={onResend}>
          Resend
        </Button>
      )}
    </div>
  );
}

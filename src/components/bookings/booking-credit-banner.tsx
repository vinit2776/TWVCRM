"use client";

/**
 * BookingCreditBanner — surfaces an active partial-checkout credit for a
 * customer + centre during the new-booking flow.
 *
 * Shown when:
 *   - bookerPhone is filled in
 *   - locationId is selected
 *   - booking duration is known
 *   - the API returned at least one active credit for that phone+centre
 *
 * The picker chooses the most recent credit (typical case = a single
 * one). If multiple are present, FIFO would normally apply but at this
 * volume (<2% of bookings ever issue credits) we show the first one
 * and let the staff verify by hovering.
 */

import { useEffect, useState } from "react";
import { Coins, Check } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { BookingCredit } from "@/types";

interface ActiveCredit extends BookingCredit {
  hours_remaining: number;
}

interface Props {
  bookerPhone: string;
  locationId: string;
  durationHours: number;
  /** Lifted to the parent so the booking submit can include credit_id + hours_to_redeem. */
  applied: { credit: ActiveCredit; hours_to_redeem: number } | null;
  onApply: (credit: ActiveCredit, hours: number) => void;
  onClear: () => void;
}

export function BookingCreditBanner({
  bookerPhone, locationId, durationHours, applied, onApply, onClear,
}: Props) {
  const [credits, setCredits] = useState<ActiveCredit[]>([]);
  const [loading, setLoading] = useState(false);

  // Re-fetch whenever the inputs change. Skipping on missing values
  // avoids a flood of 400s as the user types.
  useEffect(() => {
    const phone = bookerPhone.trim();
    if (!phone || !locationId) {
      setCredits([]);
      return;
    }
    setLoading(true);
    const url = `/api/booking-credits?phone=${encodeURIComponent(phone)}&location_id=${locationId}`;
    fetch(url)
      .then((r) => r.json())
      .then((j) => setCredits(j.data || []))
      .catch(() => setCredits([]))
      .finally(() => setLoading(false));
  }, [bookerPhone, locationId]);

  if (!loading && credits.length === 0) return null;

  const credit = credits[0];
  const isApplied = applied?.credit.id === credit?.id;

  // Default redemption — cap at booking duration AND credit's remaining,
  // floored so we don't try to redeem partial hours.
  const maxRedeemable = credit
    ? Math.min(credit.hours_remaining, Math.floor(durationHours || 0))
    : 0;

  if (loading) {
    return (
      <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
        <Coins className="h-3.5 w-3.5 animate-pulse" />
        Checking for credits…
      </div>
    );
  }

  if (!credit || maxRedeemable === 0) {
    // Credit exists but can't be applied (booking too short for whole-hour
    // redemption). Still surface so staff can see the credit is there.
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
        <Coins className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div>
          <strong>{credit?.hours_remaining ?? 0}h credit available</strong>
          {" "}for this customer at this centre — but the booking is too short to redeem
          (need at least 1 full hour). Expires {credit?.expires_at ? formatDate(credit.expires_at) : "—"}.
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-md border px-3 py-2.5 text-sm flex items-center justify-between gap-3 ${
      isApplied
        ? "border-emerald-300 bg-emerald-50 text-emerald-900"
        : "border-blue-200 bg-blue-50 text-blue-900"
    }`}>
      <div className="flex items-start gap-2 min-w-0">
        <Coins className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium leading-tight">
            {isApplied
              ? <>✓ Applying {applied.hours_to_redeem}h of credit ({formatCurrency(applied.hours_to_redeem * Number(credit.hourly_rate_snapshot))} off)</>
              : <>{credit.hours_remaining}h credit available — covers {maxRedeemable}h of this booking</>}
          </p>
          <p className="text-[11px] opacity-80 leading-tight mt-0.5">
            Issued {formatDate(credit.issued_at)} · expires {formatDate(credit.expires_at)}
            {credit.issued_from_booking?.booking_number && <> · from {credit.issued_from_booking.booking_number}</>}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => isApplied ? onClear() : onApply(credit, maxRedeemable)}
        className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-semibold border transition-colors ${
          isApplied
            ? "border-emerald-400 bg-white hover:bg-emerald-100"
            : "border-blue-400 bg-white hover:bg-blue-100"
        }`}
      >
        {isApplied ? <><Check className="h-3 w-3 mr-1 inline" />Applied</> : `Apply ${maxRedeemable}h`}
      </button>
    </div>
  );
}

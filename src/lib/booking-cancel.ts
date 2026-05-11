/**
 * Shared cancellation side-effects for bookings.
 *
 * Both the PATCH cancel branch (`/api/bookings/[id]`) and the rich
 * POST cancel endpoint (`/api/bookings/[id]/cancel`) need the same
 * three side-effects when a booking is cancelled or marked no-show:
 *
 *   1. Revoke walk-in / guest WiFi vouchers
 *   2. Waive the linked usage_charge
 *   3. Auto-offer the freed slot to the first waitlisted customer
 *
 * This module extracts them into one function so the logic stays DRY
 * and every cancel path (including no-show) gets all three.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseAny = any;

export interface BookingCancelContext {
  bookingId: string;
  customerType: string;
  usageChargeId: string | null;
  spaceId: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
}

export interface CancelSideEffectOptions {
  /** Skip the waitlist auto-offer (e.g. for no-show where the slot is past). */
  skipWaitlistOffer?: boolean;
}

export interface CancelSideEffectResult {
  vouchersRevoked: number;
  usageChargeWaived: boolean;
  waitlistOffered: boolean;
}

/**
 * Execute the side-effects that accompany every booking cancellation
 * or no-show. Idempotent for voucher revocation (only revokes active
 * issuances). Non-blocking — callers should `await` but failures in
 * individual side-effects are logged, not thrown, so the parent
 * status update is never rolled back.
 */
export async function executeBookingCancellationSideEffects(
  supabase: SupabaseAny,
  booking: BookingCancelContext,
  options: CancelSideEffectOptions = {},
): Promise<CancelSideEffectResult> {
  const result: CancelSideEffectResult = {
    vouchersRevoked: 0,
    usageChargeWaived: false,
    waitlistOffered: false,
  };

  // ── 1. Revoke walk-in / guest WiFi vouchers ────────────────────
  if (booking.customerType === "walk_in" || booking.customerType === "guest") {
    try {
      const { data: issuances } = await supabase
        .from("voucher_issuances")
        .select("id, voucher_id")
        .eq("booking_id", booking.bookingId)
        .eq("is_active", true);

      if (issuances && issuances.length > 0) {
        for (const iss of issuances) {
          await supabase
            .from("voucher_issuances")
            .update({
              is_active: false,
              revoked_at: new Date().toISOString(),
              revoke_reason: "Booking cancelled",
            })
            .eq("id", iss.id);

          await supabase
            .from("voucher_repository")
            .update({ status: "revoked" })
            .eq("id", iss.voucher_id);
        }
        result.vouchersRevoked = issuances.length;
      }
    } catch (err) {
      console.error("[booking-cancel] voucher revocation failed:", err);
    }
  }

  // ── 2. Waive linked usage charge ───────────────────────────────
  if (booking.usageChargeId) {
    try {
      await supabase
        .from("usage_charges")
        .update({ status: "waived" })
        .eq("id", booking.usageChargeId);
      result.usageChargeWaived = true;
    } catch (err) {
      console.error("[booking-cancel] usage charge waiver failed:", err);
    }
  }

  // ── 3. Auto-offer slot to first waitlisted customer ────────────
  // Skipped for no-show because the time slot is already past and
  // cannot be offered to another customer.
  if (!options.skipWaitlistOffer) {
    try {
      const { data: waitlistEntries } = await supabase
        .from("booking_waitlist")
        .select("id")
        .eq("space_id", booking.spaceId)
        .eq("booking_date", booking.bookingDate)
        .eq("status", "waiting")
        .lt("start_time", booking.endTime)
        .gt("end_time", booking.startTime)
        .order("created_at", { ascending: true })
        .limit(1);

      if (waitlistEntries && waitlistEntries.length > 0) {
        await supabase
          .from("booking_waitlist")
          .update({
            status: "offered",
            notified_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 2 * 3600000).toISOString(),
          })
          .eq("id", waitlistEntries[0].id);
        result.waitlistOffered = true;
      }
    } catch (err) {
      console.error("[booking-cancel] waitlist auto-offer failed:", err);
    }
  }

  return result;
}

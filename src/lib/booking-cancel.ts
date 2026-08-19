/**
 * Shared cancellation side-effects for bookings.
 *
 * Both the PATCH cancel branch (`/api/bookings/[id]`) and the rich
 * POST cancel endpoint (`/api/bookings/[id]/cancel`) need the same
 * three side-effects when a booking is cancelled or marked no-show:
 *
 *   1. Revoke any active WiFi vouchers for the booking (all customer types)
 *   2. Waive the linked usage_charge
 *   3. Auto-offer the freed slot to the first waitlisted customer
 *
 * This module extracts them into one function so the logic stays DRY
 * and every cancel path (including no-show) gets all three.
 */

import { revokeUnifiVoucher } from "@/lib/unifi";

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
  /** Skip waiving the usage charge (e.g. on checkout where charge should stand). */
  skipUsageChargeWaiver?: boolean;
  /** Override the revoke_reason stored on the issuance row. */
  revokeReason?: string;
}

export interface CancelSideEffectResult {
  /** Issuances released from the booking (includes ones we could not kill). */
  vouchersRevoked: number;
  /**
   * Ruijie-issued codes that were released on paper but are STILL USABLE on
   * the network — the Ruijie Cloud API has no revocation endpoint, so they
   * keep working until they expire on their own. Callers that report
   * "vouchers revoked" to a human must mention this, or the message is false.
   */
  vouchersStillLive: number;
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
    vouchersStillLive: 0,
    usageChargeWaived: false,
    waitlistOffered: false,
  };

  const revokeReason = options.revokeReason ?? "Booking cancelled";

  // ── 1. Revoke any active WiFi vouchers for this booking ────────
  // Applies to all customer types (walk_in, guest, member, etc.).
  // Idempotent — only touches rows with is_active = true.
  try {
    const { data: issuances } = await supabase
      .from("voucher_issuances")
      .select("id, voucher_id, unifi_voucher_id, ruijie_voucher_uuid")
      .eq("booking_id", booking.bookingId)
      .eq("is_active", true);

    if (issuances && issuances.length > 0) {
      const revokeNow = new Date().toISOString();

      // Ruijie Cloud exposes no revocation endpoint, so a Ruijie code CANNOT be
      // switched off — it stays usable until its own expiry. We still release the
      // issuance from the booking, but the stored reason must say so, otherwise
      // the CRM records a revocation that never happened and staff will tell a
      // guest their access was cut when it wasn't. UniFi and repository codes are
      // genuinely killed below, so they keep the normal reason.
      const isRuijieOnly = (i: { unifi_voucher_id?: string | null; voucher_id?: string | null; ruijie_voucher_uuid?: string | null }) =>
        !!i.ruijie_voucher_uuid && !i.unifi_voucher_id && !i.voucher_id;

      const ruijieIds = issuances.filter(isRuijieOnly).map((i: { id: string }) => i.id);
      const killableIds = issuances.filter((i: Parameters<typeof isRuijieOnly>[0]) => !isRuijieOnly(i)).map((i: { id: string }) => i.id);

      if (killableIds.length > 0) {
        await supabase
          .from("voucher_issuances")
          .update({ is_active: false, revoked_at: revokeNow, revoke_reason: revokeReason })
          .in("id", killableIds);
      }
      if (ruijieIds.length > 0) {
        await supabase
          .from("voucher_issuances")
          .update({
            is_active: false,
            revoked_at: revokeNow,
            revoke_reason: `${revokeReason} — code NOT disabled: Ruijie has no revocation API, so it stays usable until it expires`,
          })
          .in("id", ruijieIds);
        result.vouchersStillLive = ruijieIds.length;
        console.warn(
          `[booking-cancel] ${ruijieIds.length} Ruijie voucher(s) on booking ${booking.bookingId} released but still live — Ruijie has no revoke API.`
        );
      }

      // Revoke repository-based vouchers
      const voucherIds = issuances
        .map((i: { voucher_id: string | null }) => i.voucher_id)
        .filter(Boolean);
      if (voucherIds.length > 0) {
        await supabase
          .from("voucher_repository")
          .update({ status: "revoked" })
          .in("id", voucherIds);
      }

      // Revoke Unifi live-API vouchers (fire-and-forget, non-fatal)
      for (const issuance of issuances) {
        const uid = (issuance as { unifi_voucher_id?: string | null }).unifi_voucher_id;
        if (uid) {
          revokeUnifiVoucher(uid).catch((err: unknown) =>
            console.error(`[booking-cancel] Unifi revoke ${uid} failed:`, err)
          );
        }
      }

      result.vouchersRevoked = issuances.length;
    }
  } catch (err) {
    console.error("[booking-cancel] voucher revocation failed:", err);
  }

  // ── 2. Waive linked usage charge ───────────────────────────────
  // Zero the amount fields along with the status — every other waiver
  // path in the codebase (free-quota bookings, free-quota facility
  // charges) treats status:"waived" as meaning ₹0, and downstream
  // displays (e.g. the Billing page's Usage Charges table) read
  // `total` directly without checking status. Leaving a stale total
  // here made a cancelled, never-billed booking look like it was
  // still charging the customer.
  if (booking.usageChargeId && !options.skipUsageChargeWaiver) {
    try {
      await supabase
        .from("usage_charges")
        .update({ status: "waived", unit_price: 0, total: 0, gst_amount: 0, total_with_gst: 0 })
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

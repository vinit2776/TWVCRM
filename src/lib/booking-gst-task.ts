/**
 * booking-gst-task.ts — SERVER-ONLY
 *
 * Shared helper that creates a booking_gst_tasks row when the trigger
 * conditions are met (booking.status = checked_out AND payment_status = paid,
 * excluding posted_to_bill / waived / prepaid).
 *
 * Called from:
 *   - PATCH /api/bookings/[id]  (checkout path)
 *   - PATCH /api/booking-payments/[id]  (payment verification path)
 *
 * Both callers use createAdminClient() before invoking this so the insert
 * bypasses RLS (task creation is a system side-effect, not a user action).
 * The UNIQUE constraint on booking_id makes this idempotent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const EXCLUDED_PAYMENT_STATUSES = ["posted_to_bill", "waived", "prepaid"] as const;

/**
 * Creates a booking_gst_tasks row if one doesn't already exist for this
 * booking. Silently skips if:
 *   - booking.status != "checked_out"
 *   - booking.payment_status is excluded (posted_to_bill / waived / prepaid)
 *   - a task already exists (idempotent — UNIQUE ON booking_id)
 *
 * Always fire-and-forget safe: errors are logged, never thrown.
 */
export async function maybeCreateBookingGstTask(
  adminClient: SupabaseClient,
  bookingId: string,
): Promise<void> {
  try {
    const { data: booking, error: fetchErr } = await adminClient
      .from("bookings")
      .select("id, status, payment_status")
      .eq("id", bookingId)
      .maybeSingle();

    if (fetchErr || !booking) {
      console.warn(`[booking-gst-task] booking ${bookingId} not found or fetch error:`, fetchErr?.message);
      return;
    }

    if (booking.status !== "checked_out") return;
    if ((EXCLUDED_PAYMENT_STATUSES as readonly string[]).includes(booking.payment_status)) return;
    if (booking.payment_status !== "paid") return;

    const { error: insertErr } = await adminClient
      .from("booking_gst_tasks")
      .upsert({ booking_id: bookingId }, { onConflict: "booking_id", ignoreDuplicates: true });

    if (insertErr) {
      console.error(`[booking-gst-task] insert failed for booking ${bookingId}:`, insertErr.message);
    } else {
      console.info(`[booking-gst-task] task created/verified for booking ${bookingId}`);
    }
  } catch (err) {
    console.error(`[booking-gst-task] unexpected error for booking ${bookingId}:`, err);
  }
}

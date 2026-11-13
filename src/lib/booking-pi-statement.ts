/**
 * Pure rules for the billing statement behind a booking's PI — no Supabase, so
 * they unit test. The statement is what puts the PI into Receivables and the
 * follow-up ladder; the booking stays the owner of the money and of the single
 * Tally handoff (its booking_gst_task), so this statement never goes to the
 * Tally Inbox itself.
 */

export const BOOKING_PI_CREATED_VIA = "booking_pi";

/** A PI is chased from this many days after it was issued. */
export const BOOKING_PI_DUE_DAYS = 7;

/** YYYY-MM-DD, `days` after the given YYYY-MM-DD (UTC arithmetic, no DST). */
export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today in IST as YYYY-MM-DD. */
export function todayIstYmd(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function bookingPiDueDate(now: Date = new Date()): string {
  return addDaysYmd(todayIstYmd(now), BOOKING_PI_DUE_DAYS);
}

export interface MirrorablePayment {
  id: string;
  amount: number | string;
  payment_mode: string;
  payment_reference: string | null;
  razorpay_payment_id: string | null;
  created_at: string;
}

/** Marker stored on the mirrored billing payment so a sync never copies a booking payment twice. */
export function bookingPaymentMarker(paymentId: string): string {
  return `booking_payment:${paymentId}`;
}

/**
 * Which verified booking payments still need a billing_payments row. A payment
 * the webhook or a manual record already put on the statement is recognised by
 * the marker (or by the same Razorpay payment id) and skipped.
 */
export function paymentsToMirror(
  verified: MirrorablePayment[],
  existing: { payment_reference: string | null; razorpay_payment_id: string | null }[],
): MirrorablePayment[] {
  const seenMarkers = new Set(existing.map((e) => e.payment_reference).filter(Boolean));
  const seenRzp = new Set(existing.map((e) => e.razorpay_payment_id).filter(Boolean));
  return verified.filter(
    (p) =>
      !seenMarkers.has(bookingPaymentMarker(p.id)) &&
      !(p.razorpay_payment_id && seenRzp.has(p.razorpay_payment_id)),
  );
}

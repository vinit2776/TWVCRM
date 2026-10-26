/**
 * Pure rules for walk-in booking payments — no Supabase, so they unit test.
 *
 * Two questions the booking routes ask:
 *
 *   1. May a walk-in check in? Cash, card and self-verified UPI become
 *      'verified' immediately. A UPI payment from a role that can't self-verify
 *      waits for accounts, and the customer is at the counter. The GST invoice
 *      is already gated on verification (the GST task needs payment_status =
 *      paid, which only a verified payment sets), so letting the person in does
 *      not issue anything early.
 *
 *   2. Would verifying this payment over-credit the booking? The customer can
 *      pay twice, and staff can record the same UPI twice. Two pending rows
 *      each pass a check against verified payments only.
 */

/** Rupee tolerance, the same epsilon insert_booking_payment_atomic uses. */
export const BOOKING_PAYMENT_EPSILON = 0.01;

export interface BookingPaymentLike {
  amount: number | string;
  status: string;
  payment_mode: string;
  payment_reference?: string | null;
  screenshot_path?: string | null;
}

const toNumber = (v: number | string) => Number(v) || 0;

export function sumByStatus(payments: BookingPaymentLike[], status: string): number {
  return payments
    .filter((p) => p.status === status)
    .reduce((sum, p) => sum + toNumber(p.amount), 0);
}

/**
 * A pending manual-UPI payment counts as provisional cover only when staff
 * attached something accounts can check it against: the screenshot or the UTR.
 * A bare amount with neither is a claim with nothing behind it.
 */
export function hasProof(p: BookingPaymentLike): boolean {
  return !!(p.screenshot_path || (p.payment_reference && p.payment_reference.trim()));
}

export interface CheckInPaymentState {
  grandTotal: number;
  verified: number;
  /** Pending UPI with proof, awaiting accounts. */
  provisional: number;
  /** True when the walk-in may check in. */
  covered: boolean;
  /** True when it may only because of provisional cover. */
  isProvisional: boolean;
}

export function checkInPaymentState(
  grandTotal: number,
  payments: BookingPaymentLike[],
): CheckInPaymentState {
  const verified = sumByStatus(payments, "verified");
  const provisional = payments
    .filter((p) => p.status === "pending" && p.payment_mode === "upi" && hasProof(p))
    .reduce((sum, p) => sum + toNumber(p.amount), 0);

  const covered = verified + provisional >= grandTotal - BOOKING_PAYMENT_EPSILON;
  const verifiedCovers = verified >= grandTotal - BOOKING_PAYMENT_EPSILON;
  return { grandTotal, verified, provisional, covered, isProvisional: covered && !verifiedCovers };
}

/**
 * Whether verifying `amount` on top of what is already verified would exceed
 * the booking total. Returns the excess (0 when it fits).
 */
export function verifyExcess(grandTotal: number, verifiedTotal: number, amount: number): number {
  const excess = verifiedTotal + amount - grandTotal;
  return excess > BOOKING_PAYMENT_EPSILON ? Math.round(excess * 100) / 100 : 0;
}

/** Another live payment on the same booking carrying the same reference. */
export function findDuplicateReference(
  payments: Array<{ id?: string; status: string; payment_reference?: string | null }>,
  reference: string | null | undefined,
): boolean {
  const ref = reference?.trim().toLowerCase();
  if (!ref) return false;
  return payments.some(
    (p) => p.status !== "rejected" && p.payment_reference?.trim().toLowerCase() === ref,
  );
}

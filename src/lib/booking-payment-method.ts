/**
 * booking-payment-method.ts — SERVER-ONLY
 *
 * Rules for correcting the payment method of a booking payment.
 *
 * A wrongly-entered method (e.g. cash instead of UPI) stays correctable until
 * accounts uploads the GST invoice against the booking's Tally Inbox task —
 * after that the invoice and the ledger are built on the recorded method.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// Razorpay payments carry a gateway transaction id, so their method is never
// hand-edited — only the manually-recorded modes can be corrected.
export const CORRECTABLE_PAYMENT_MODES = ["cash", "upi", "card"] as const;
export type CorrectablePaymentMode = (typeof CORRECTABLE_PAYMENT_MODES)[number];

export const PAYMENT_METHOD_EDIT_ROLES = ["admin", "accounts", "manager"] as const;

export const GST_INVOICE_LOCK_MESSAGE =
  "A GST invoice has been issued for this booking, so the payment method can no longer be changed.";

/**
 * True once an active (non-superseded) GST invoice upload exists on the
 * booking's Tally Inbox task. Needs an admin client: the inbox tables are
 * RLS-restricted to inbox roles, and managers/front desk must still be told
 * the booking is locked.
 */
export async function isBookingPaymentMethodLocked(
  adminClient: SupabaseClient,
  bookingId: string,
): Promise<boolean> {
  const { data: task } = await adminClient
    .from("booking_gst_tasks")
    .select("id")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!task) return false;

  const { count, error } = await adminClient
    .from("gst_invoice_uploads")
    .select("id", { count: "exact", head: true })
    .eq("booking_gst_task_id", task.id)
    .is("superseded_by", null);

  // Fail closed: if we can't tell, don't allow a change to a possibly-invoiced payment.
  if (error) return true;
  return (count ?? 0) > 0;
}

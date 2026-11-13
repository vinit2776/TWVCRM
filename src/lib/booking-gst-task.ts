/**
 * booking-gst-task.ts — SERVER-ONLY
 *
 * Shared helper that creates, refreshes or adds to a booking's booking_gst_tasks rows
 * (the main task, and a supplement for an extra raised after the invoice was issued)
 * when the trigger conditions are met (booking.status = checked_out AND payment_status = paid,
 * excluding posted_to_bill / waived / prepaid).
 *
 * Called from:
 *   - PATCH /api/bookings/[id]  (checkout path)
 *   - PATCH /api/booking-payments/[id]  (payment verification path)
 *
 * Both callers use createAdminClient() before invoking this so the insert
 * bypasses RLS (task creation is a system side-effect, not a user action).
 * The unique index on (booking_id, sequence) makes this idempotent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { planGstTasks, type TaskLike } from "@/lib/booking-extras";

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
      .select("id, status, payment_status, customer_type, contract_id, total_amount_with_gst")
      .eq("id", bookingId)
      .maybeSingle();

    if (fetchErr || !booking) {
      console.warn(`[booking-gst-task] booking ${bookingId} not found or fetch error:`, fetchErr?.message);
      return;
    }

    if (booking.status !== "checked_out") return;
    if ((EXCLUDED_PAYMENT_STATUSES as readonly string[]).includes(booking.payment_status)) return;
    if (booking.payment_status !== "paid") return;
    // Fix #5: Contract-holder bookings are billed through the monthly statement
    // cycle — creating a separate booking GST task would duplicate the invoice.
    if (booking.customer_type === "contract_holder" || booking.contract_id != null) return;

    const { data: tasks } = await adminClient
      .from("booking_gst_tasks")
      .select("id, kind, sequence, amount_with_gst, handoff_state, gst_invoice_number, tally_invoice_number, voided_at")
      .eq("booking_id", bookingId)
      .order("sequence", { ascending: true });

    const plan = planGstTasks(Number(booking.total_amount_with_gst) || 0, (tasks || []) as TaskLike[]);

    if (plan.action === "create_main") {
      const { error } = await adminClient
        .from("booking_gst_tasks")
        .upsert(
          { booking_id: bookingId, kind: "main", sequence: 1, amount_with_gst: plan.amount },
          { onConflict: "booking_id,sequence", ignoreDuplicates: true },
        );
      if (error) console.error(`[booking-gst-task] insert failed for booking ${bookingId}:`, error.message);
      else console.info(`[booking-gst-task] task created/verified for booking ${bookingId}`);
    } else if (plan.action === "refresh") {
      // An extra paid before accounts started the invoice folds into it: one invoice, full amount.
      const target = (tasks || [])[plan.taskIndex] as { id: string };
      await adminClient.from("booking_gst_tasks").update({ amount_with_gst: plan.amount }).eq("id", target.id);
    } else if (plan.action === "create_supplement") {
      const { data: created, error } = await adminClient
        .from("booking_gst_tasks")
        .insert({ booking_id: bookingId, kind: "supplement", sequence: plan.sequence, amount_with_gst: plan.amount })
        .select("id")
        .single();
      // A concurrent call that made the same supplement hits the unique index; that is fine.
      if (error && error.code !== "23505") {
        console.error(`[booking-gst-task] supplement failed for booking ${bookingId}:`, error.message);
      } else if (created) {
        // The supplement covers the extras no earlier invoice has claimed.
        await adminClient
          .from("booking_addons")
          .update({ gst_task_id: created.id })
          .eq("booking_id", bookingId)
          .is("gst_task_id", null);
      }
    }
  } catch (err) {
    console.error(`[booking-gst-task] unexpected error for booking ${bookingId}:`, err);
  }
}

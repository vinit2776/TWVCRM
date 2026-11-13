/**
 * booking-pi-statement-server.ts — SERVER-ONLY
 *
 * Keeps the billing statement behind a booking's PI in step with the booking.
 * The statement is what lists the PI in Receivables as pending and lets the
 * follow-up ladder chase it. The booking stays the owner of the money and of
 * the single Tally handoff (booking_gst_tasks), so none of this ever sets a
 * handoff state that would put the statement in the Tally Inbox as well.
 *
 * Every function takes a service-role client (billing_statements writes are
 * not for the signed-in user's RLS) and never throws: failures are logged so
 * the booking action that triggered them is not rolled back.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";
import { bookingPaymentTolerance } from "@/lib/booking-payment-rules";
import { totalPaid } from "@/lib/settlement";
import type { BookingPiTotals } from "@/lib/booking-pi";
import {
  BOOKING_PI_CREATED_VIA, bookingPaymentMarker, bookingPiDueDate, paymentsToMirror, todayIstYmd,
} from "@/lib/booking-pi-statement";

async function findLiveStatement(admin: SupabaseClient, bookingId: string) {
  const { data } = await admin
    .from("billing_statements")
    .select("id, total_amount, payment_status, razorpay_payment_link_id")
    .eq("booking_id", bookingId)
    .eq("created_via", BOOKING_PI_CREATED_VIA)
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { id: string; total_amount: number; payment_status: string; razorpay_payment_link_id: string | null } | null;
}

/**
 * Create the statement when the PI is sent, or refresh it on a resend. A
 * resend never changes the figures of a statement that already has payments.
 */
export async function upsertBookingPiStatement(
  admin: SupabaseClient,
  args: {
    bookingId: string;
    leadId: string | null;
    piNumber: string;
    totals: BookingPiTotals;
    gstRate: number;
    linkId: string | null;
    linkUrl: string | null;
  },
): Promise<{ statementId: string | null }> {
  try {
    const nowIso = new Date().toISOString();
    const existing = await findLiveStatement(admin, args.bookingId);

    if (existing) {
      const { count } = await admin
        .from("billing_payments")
        .select("id", { count: "exact", head: true })
        .eq("billing_statement_id", existing.id);
      const untouched = !count && existing.payment_status === "unpaid";
      await admin
        .from("billing_statements")
        .update({
          razorpay_payment_link_id: args.linkId,
          razorpay_payment_link_url: args.linkUrl,
          proforma_sent_at: nowIso,
          emailed_at: nowIso,
          ...(untouched ? { total_amount: args.totals.total } : {}),
        })
        .eq("id", existing.id);
      return { statementId: existing.id };
    }

    const today = todayIstYmd();
    const hsn = resolveHsnCode("booking_usage");
    const items = args.totals.lines.map((l) => ({
      description: l.description,
      qty: l.quantity,
      unit_price: l.rate,
      amount: l.amount,
      hsn_sac_code: hsn,
    }));
    const { data, error } = await admin
      .from("billing_statements")
      .insert({
        booking_id: args.bookingId,
        contract_id: null,
        lead_id: args.leadId,
        statement_type: "usage",
        created_via: BOOKING_PI_CREATED_VIA,
        status: "finalized",
        payment_status: "unpaid",
        // Not an inbox state: the Tally handoff for this booking is its own task.
        handoff_state: "pi_awaiting_payment",
        period_start: today,
        period_end: today,
        subtotal: args.totals.subtotal,
        fixed_amount: args.totals.subtotal,
        tax_percentage: args.gstRate,
        tax_amount: args.totals.gst,
        total_amount: args.totals.total,
        due_date: bookingPiDueDate(),
        razorpay_payment_link_id: args.linkId,
        razorpay_payment_link_url: args.linkUrl,
        // Delivery stamps: the follow-up ladder never chases what the customer has not received.
        proforma_sent_at: nowIso,
        emailed_at: nowIso,
        line_items: [{ type: "usage", label: `Booking ${args.piNumber}`, items, subtotal: args.totals.subtotal }],
      })
      .select("id")
      .single();
    if (error) {
      console.error(`[booking-pi-statement] insert failed for booking ${args.bookingId}:`, error.message);
      return { statementId: null };
    }
    return { statementId: data.id as string };
  } catch (err) {
    console.error(`[booking-pi-statement] upsert failed for booking ${args.bookingId}:`, err);
    return { statementId: null };
  }
}

/**
 * Bring the statement's payments and status in line with the booking's
 * verified payments. Called after any payment lands on the booking: link
 * (webhook), cash/card at the counter, or a UPI payment verified by accounts.
 * Safe to call when the booking has no PI statement (it does nothing).
 */
export async function syncBookingPiStatement(admin: SupabaseClient, bookingId: string): Promise<void> {
  try {
    const statement = await findLiveStatement(admin, bookingId);
    if (!statement) return;

    const [{ data: verified }, { data: existing }, { data: booking }] = await Promise.all([
      admin
        .from("booking_payments")
        .select("id, amount, payment_mode, payment_reference, razorpay_payment_id, created_at")
        .eq("booking_id", bookingId)
        .eq("status", "verified"),
      admin
        .from("billing_payments")
        .select("payment_reference, razorpay_payment_id")
        .eq("billing_statement_id", statement.id),
      admin.from("bookings").select("payment_status").eq("id", bookingId).maybeSingle(),
    ]);

    const missing = paymentsToMirror(verified || [], existing || []);
    if (missing.length > 0) {
      await admin.from("billing_payments").insert(
        missing.map((p) => ({
          billing_statement_id: statement.id,
          amount: Number(p.amount),
          payment_date: todayIstYmd(new Date(p.created_at)),
          payment_mode: p.payment_mode,
          payment_reference: bookingPaymentMarker(p.id),
          razorpay_payment_id: p.razorpay_payment_id,
          notes: "Recorded on the booking",
        })),
      );
    }

    const { data: all } = await admin
      .from("billing_payments")
      .select("amount, tds_amount")
      .eq("billing_statement_id", statement.id);
    const paid = totalPaid(all);
    const total = Number(statement.total_amount);
    const settled = booking?.payment_status === "paid" || paid >= total - bookingPaymentTolerance(total);
    const next = settled ? "paid" : paid > 0 ? "partially_paid" : "unpaid";
    if (next !== statement.payment_status) {
      await admin.from("billing_statements").update({ payment_status: next }).eq("id", statement.id);
    }
  } catch (err) {
    console.error(`[booking-pi-statement] sync failed for booking ${bookingId}:`, err);
  }
}

/**
 * Cancel the PI when its booking is cancelled or marked no-show: void the
 * statement so Receivables stops listing it and the ladder stops chasing, and
 * cancel the shared Razorpay link so the customer cannot pay a cancelled
 * booking. A statement that already has money on it is left alone: that
 * payment is a refund to be handled by hand, not something to void.
 */
export async function cancelBookingPiStatement(
  admin: SupabaseClient,
  bookingId: string,
  reason: string,
  performedBy: string | null = null,
): Promise<{ voided: boolean; heldBecausePaid: boolean }> {
  try {
    const statement = await findLiveStatement(admin, bookingId);
    if (!statement) return { voided: false, heldBecausePaid: false };

    const { count } = await admin
      .from("billing_payments")
      .select("id", { count: "exact", head: true })
      .eq("billing_statement_id", statement.id);
    if (count || statement.payment_status !== "unpaid") {
      return { voided: false, heldBecausePaid: true };
    }

    const { error } = await admin
      .from("billing_statements")
      .update({
        status: "voided",
        voided_at: new Date().toISOString(),
        voided_by: performedBy,
        void_reason: reason,
      })
      .eq("id", statement.id)
      .is("voided_at", null);
    if (error) {
      console.error(`[booking-pi-statement] void failed for booking ${bookingId}:`, error.message);
      return { voided: false, heldBecausePaid: false };
    }

    // Best-effort, as in the statement void route: the void is already committed.
    if (statement.razorpay_payment_link_id) {
      try {
        const { data: settings } = await admin
          .from("app_settings")
          .select("key, value")
          .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
        const rzp: Record<string, string> = {};
        (settings || []).forEach((s: { key: string; value: string }) => { rzp[s.key] = s.value; });
        if (rzp.razorpay_enabled === "true" && rzp.razorpay_key_id && rzp.razorpay_key_secret) {
          const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
          const res = await fetch(
            `https://api.razorpay.com/v1/payment_links/${statement.razorpay_payment_link_id}/cancel`,
            { method: "POST", headers: { Authorization: `Basic ${auth}` } },
          );
          if (!res.ok) console.warn("[booking-pi-statement] Razorpay link cancel failed (non-fatal):", await res.text());
        }
      } catch (e) {
        console.warn("[booking-pi-statement] Razorpay cancel error (non-fatal):", e);
      }
    }
    return { voided: true, heldBecausePaid: false };
  } catch (err) {
    console.error(`[booking-pi-statement] cancel failed for booking ${bookingId}:`, err);
    return { voided: false, heldBecausePaid: false };
  }
}

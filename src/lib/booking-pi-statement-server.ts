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

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";
import { bookingPaymentTolerance } from "@/lib/booking-payment-rules";
import { maybeCreateBookingGstTask } from "@/lib/booking-gst-task";
import { logAudit } from "@/lib/audit";
import { totalPaid } from "@/lib/settlement";
import { buildBookingPi, type BookingPiAddon, type BookingPiTotals } from "@/lib/booking-pi";
import {
  BOOKING_PI_CREATED_VIA, bookingNoLongerOwes, bookingPaymentMarker, bookingPiDueDate, mirroredRowsToRemove,
  bookingModeForStatementPayment, paymentsToMirror, statementPaymentStatus, todayIstYmd,
} from "@/lib/booking-pi-statement";

function piLineItems(totals: BookingPiTotals) {
  const hsn = resolveHsnCode("booking_usage");
  return totals.lines.map((l) => ({
    description: l.description,
    qty: l.quantity,
    unit_price: l.rate,
    amount: l.amount,
    hsn_sac_code: hsn,
  }));
}

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
    const items = piLineItems(args.totals);
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
 * Bring the statement in line with its booking: voided if the booking no longer
 * owes the money, its payments mirrored from the booking's verified payments
 * (and any mirror of a payment that was since cancelled removed), its figures
 * refreshed from the booking's current total, and its status recomputed.
 * Called after anything that changes the booking's money: a payment landing or
 * being cancelled, an add-on, a rate edit, a waiver. Safe to call when the
 * booking has no PI statement (it does nothing).
 */
export async function syncBookingPiStatement(admin: SupabaseClient, bookingId: string): Promise<void> {
  try {
    const statement = await findLiveStatement(admin, bookingId);
    if (!statement) return;

    const { data: booking } = await admin
      .from("bookings")
      .select("id, booking_number, status, payment_status, total_amount, gst_rate, gst_amount, total_amount_with_gst, duration_hours, razorpay_payment_link_id, razorpay_payment_link_url, space:spaces!bookings_space_id_fkey(name), addons:booking_addons(*)")
      .eq("id", bookingId)
      .maybeSingle();
    if (!booking) return;

    if (bookingNoLongerOwes(booking)) {
      await cancelBookingPiStatement(admin, bookingId, "Booking no longer owes this amount");
      return;
    }

    const [{ data: verified }, { data: existing }] = await Promise.all([
      admin
        .from("booking_payments")
        .select("id, amount, payment_mode, payment_reference, razorpay_payment_id, created_at")
        .eq("booking_id", bookingId)
        .eq("status", "verified"),
      admin
        .from("billing_payments")
        .select("id, payment_reference, razorpay_payment_id")
        .eq("billing_statement_id", statement.id),
    ]);

    const stale = mirroredRowsToRemove(existing || [], (verified || []).map((p) => p.id as string));
    if (stale.length > 0) {
      await admin.from("billing_payments").delete().in("id", stale.map((r) => (r as { id: string }).id));
    }

    // One insert per payment: a unique index on the marker makes a concurrent
    // sync's duplicate fail harmlessly instead of crediting the payment twice.
    for (const p of paymentsToMirror(verified || [], existing || [])) {
      const { error } = await admin.from("billing_payments").insert({
        billing_statement_id: statement.id,
        amount: Number(p.amount),
        payment_date: todayIstYmd(new Date(p.created_at)),
        payment_mode: p.payment_mode,
        payment_reference: bookingPaymentMarker(p.id),
        razorpay_payment_id: p.razorpay_payment_id,
        notes: "Recorded on the booking",
      });
      if (error && error.code !== "23505") {
        console.error(`[booking-pi-statement] mirror failed for booking ${bookingId}:`, error.message);
      }
    }

    const space = booking.space as unknown as { name: string } | null;
    const totals = buildBookingPi({
      booking_number: booking.booking_number,
      space_name: space?.name || "Meeting room",
      duration_hours: booking.duration_hours,
      total_amount: booking.total_amount,
      gst_rate: booking.gst_rate,
      gst_amount: booking.gst_amount,
      total_amount_with_gst: booking.total_amount_with_gst,
      addons: (booking.addons as BookingPiAddon[]) || [],
    });

    const { data: all } = await admin
      .from("billing_payments")
      .select("amount, tds_amount")
      .eq("billing_statement_id", statement.id);
    const next = statementPaymentStatus({
      total: totals.total,
      paid: totalPaid(all),
      bookingPaid: booking.payment_status === "paid",
      tolerance: bookingPaymentTolerance(totals.total),
    });

    await admin
      .from("billing_statements")
      .update({
        payment_status: next,
        // Follows the booking's link: an extra after checkout gets a fresh one for the balance.
        // Including none: a cleared link must not leave the statement pointing at a spent one.
        razorpay_payment_link_id: booking.razorpay_payment_link_id ?? null,
        razorpay_payment_link_url: booking.razorpay_payment_link_url ?? null,
        total_amount: totals.total,
        subtotal: totals.subtotal,
        fixed_amount: totals.subtotal,
        tax_amount: totals.gst,
        line_items: [{ type: "usage", label: `Booking ${booking.booking_number ?? ""}`.trim(), items: piLineItems(totals), subtotal: totals.subtotal }],
      })
      .eq("id", statement.id);
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
      // Money is on it, so it cannot be voided. Say why on the row itself, where
      // accounts will see it in Receivables, instead of leaving it looking live.
      await admin
        .from("billing_statements")
        .update({ notes: `Booking cancelled or no longer owed while part-paid: ${reason}. Refund any amount received offline, then cancel this PI.` })
        .eq("id", statement.id);
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

/**
 * For routes that act on a billing statement the generic way (send, remind,
 * raise a GST invoice). A booking's PI is paid on the booking and has one Tally
 * handoff, its booking task, so these actions would either fail (no contract,
 * proposal or invoice to resolve a customer from) or raise a second GST invoice.
 * Returns the response to send back, or null when the statement is not a booking PI.
 */
export async function rejectIfBookingPiStatement(statementId: string): Promise<NextResponse | null> {
  const { data } = await createAdminClient()
    .from("billing_statements")
    .select("booking_id, created_via")
    .eq("id", statementId)
    .maybeSingle();
  if (!data || data.created_via !== BOOKING_PI_CREATED_VIA || !data.booking_id) return null;
  return NextResponse.json(
    {
      error: "This is a booking PI. Send it, record payments and raise its GST invoice from the booking itself, so the booking and its single Tally handoff stay in step.",
      booking_id: data.booking_id,
    },
    { status: 409 },
  );
}

export type RecordBookingPiPaymentResult =
  | { ok: true; paymentId: string; markerRef: string }
  | { ok: false; status: number; error: string };

/**
 * Accounts record a booking PI's payment from Receivables. The money belongs to
 * the booking, so it is recorded there (as a verified booking payment, the same
 * RPC the counter uses) and the statement follows through the sync. That keeps the
 * booking paid, its single Tally task created, and the statement settled together.
 */
export async function recordBookingPiPayment(
  admin: SupabaseClient,
  args: {
    bookingId: string;
    amount: number;
    mode: string;
    reference: string | null;
    notes: string | null;
    proofPath: string | null;
    actor: { id: string; full_name: string | null };
  },
): Promise<RecordBookingPiPaymentResult> {
  const mode = bookingModeForStatementPayment(args.mode);
  const { data: rpc, error } = await admin.rpc("insert_booking_payment_atomic", {
    p_booking_id: args.bookingId,
    p_amount: args.amount,
    p_payment_mode: mode,
    p_payment_reference: args.reference?.trim() || null,
    p_status: "verified",
    p_created_by: args.actor.id,
    p_cash_handover_status: null,
    p_collected_by: null,
    p_collected_at: null,
    p_screenshot_verified: null,
    p_verification_notes: `Recorded from Receivables by ${args.actor.full_name ?? "accounts"}${args.notes ? `: ${args.notes}` : ""}`,
  });
  if (error) return { ok: false, status: 500, error: error.message };
  if (rpc?.error) {
    return { ok: false, status: 409, error: `${rpc.error}${rpc.balance_due != null ? ` Balance due on the booking is ₹${Number(rpc.balance_due).toLocaleString("en-IN")}.` : ""}` };
  }
  const paymentId = rpc.payment.id as string;
  if (args.proofPath) {
    await admin.from("booking_payments").update({ screenshot_path: args.proofPath }).eq("id", paymentId);
  }

  const newTotal = Number(rpc.new_total);
  const grandTotal = Number(rpc.grand_total);
  if (newTotal >= grandTotal - bookingPaymentTolerance(grandTotal)) {
    await admin.from("bookings").update({ payment_status: "paid", payment_mode: mode }).eq("id", args.bookingId);
    await maybeCreateBookingGstTask(admin, args.bookingId);
  }
  await syncBookingPiStatement(admin, args.bookingId);

  void logAudit(admin, {
    entityType: "booking_payment",
    entityId: paymentId,
    action: "create",
    performedBy: args.actor.id,
    changes: {
      amount: { old: null, new: args.amount },
      payment_mode: { old: null, new: mode },
      status: { old: null, new: "verified" },
    },
  });
  return { ok: true, paymentId, markerRef: bookingPaymentMarker(paymentId) };
}

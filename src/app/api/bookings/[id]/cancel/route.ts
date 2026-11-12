/**
 * POST /api/bookings/[id]/cancel
 *
 * Rich cancellation flow that replaces the bare "set status to
 * cancelled" path. Handles, in one atomic-ish unit:
 *
 *   1. State transition: booking → cancelled (with reason + details)
 *   2. Side effects (preserved from the legacy PATCH cancel path):
 *      - revoke any walk-in / guest WiFi vouchers
 *      - waive linked usage_charge (contract / guest bookings)
 *      - offer the slot to anyone on the waitlist
 *   3. Optional lead caution — auto-prefilled to `danger` severity
 *      when reason = `suspected_fake_booking`
 *   4. Optional refund_request — only when payment was collected and
 *      staff flagged the cancellation as refund-eligible. Goes into
 *      pending_approval, awaiting manager / admin sign-off.
 *   5. gst_invoice_required flag — set when payment was collected and
 *      no refund was requested (so finance can issue a GST invoice
 *      for the retained payment).
 *
 * Body:
 *   {
 *     reason: BookingCancellationReason,
 *     details?: string,                              // required when reason = "other"
 *     caution?: { note: string, severity: "info" | "warning" | "danger" },
 *     refund_request?: {
 *       amount: number,
 *       reason: string,                              // RefundRequestReason picklist
 *       details?: string,
 *     },
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { executeBookingCancellationSideEffects } from "@/lib/booking-cancel";

type CancellationReason =
  | "customer_requested" | "no_show" | "overbooking_error"
  | "suspected_fake_booking" | "centre_operational_issue" | "other";

const VALID_REASONS = new Set<CancellationReason>([
  "customer_requested", "no_show", "overbooking_error",
  "suspected_fake_booking", "centre_operational_issue", "other",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();
  const reason = body.reason as CancellationReason | undefined;
  const details = (body.details as string | undefined)?.trim() || null;

  if (!reason || !VALID_REASONS.has(reason)) {
    return NextResponse.json({ error: "reason is required (must be a valid picklist value)" }, { status: 400 });
  }
  if (reason === "other" && !details) {
    return NextResponse.json({ error: "details required when reason is 'other'" }, { status: 400 });
  }

  // Load booking + lead so we can attach the caution and run side effects.
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select(`
      id, booking_number, status, customer_type, lead_id, payment_status,
      total_amount, total_amount_with_gst, usage_charge_id, created_by,
      space_id, booking_date, start_time, end_time
    `)
    .eq("id", id)
    .single();

  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // State-machine guard. Cancellation only valid from confirmed; once
  // checked-in or beyond, the customer used the room and refunds /
  // disputes go through a different flow.
  if (booking.status !== "confirmed") {
    return NextResponse.json(
      { error: `Cannot cancel a ${booking.status} booking` },
      { status: 400 }
    );
  }

  // Permission: same as the legacy cancel — admin/manager can cancel
  // anything; sales reps can only cancel bookings they created.
  const canManage = ["admin", "manager"].includes(dbUser.role);
  if (!canManage && booking.created_by !== dbUser.id) {
    return NextResponse.json({ error: "Insufficient permissions to cancel" }, { status: 403 });
  }

  // ── 1. Determine refund vs retained-payment ─────────────────────
  // Whether this booking has any verified payment to consider.
  const { data: verifiedPayments } = await supabase
    .from("booking_payments")
    .select("amount")
    .eq("booking_id", id)
    .eq("status", "verified");
  const totalCollected = (verifiedPayments || []).reduce(
    (s, p) => s + Number(p.amount), 0
  );
  const hasCollectedPayment = totalCollected > 0
    || ["paid", "prepaid"].includes(booking.payment_status);

  // refund_request is only meaningful when money was collected
  const refundReq = body.refund_request;
  const wantsRefund = !!refundReq && hasCollectedPayment;

  if (refundReq && !hasCollectedPayment) {
    return NextResponse.json(
      { error: "Cannot request refund — no payment was collected on this booking" },
      { status: 400 }
    );
  }
  if (wantsRefund) {
    if (!refundReq.reason) {
      return NextResponse.json({ error: "refund_request.reason is required" }, { status: 400 });
    }
    const amt = Number(refundReq.amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > totalCollected + 0.01) {
      return NextResponse.json(
        { error: `refund amount must be between ₹0 and ₹${totalCollected.toFixed(2)}` },
        { status: 400 }
      );
    }
  }

  // ── 2. Update booking ───────────────────────────────────────────
  // gst_invoice_required is set when payment was kept (no refund) so
  // finance can see this on their queue.
  const gstInvoiceRequired = hasCollectedPayment && !wantsRefund;

  const { data: updated, error: updateErr } = await supabase
    .from("bookings")
    .update({
      status: "cancelled",
      cancellation_reason: reason,
      cancellation_details: details,
      cancelled_by: dbUser.id,
      cancelled_at: new Date().toISOString(),
      gst_invoice_required: gstInvoiceRequired,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: "Failed to cancel: " + (updateErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  // ── 3. Side effects (shared with PATCH cancel + no-show paths) ──
  // Voucher revocation, usage charge waiver, and waitlist auto-offer.
  const sideEffects = await executeBookingCancellationSideEffects(supabase, {
    bookingId: id,
    customerType: booking.customer_type,
    usageChargeId: booking.usage_charge_id,
    spaceId: booking.space_id,
    bookingDate: booking.booking_date,
    startTime: booking.start_time,
    endTime: booking.end_time,
  });

  // ── 4. Optional lead caution ────────────────────────────────────
  // Auto-create a danger caution when reason = suspected_fake_booking
  // even if staff didn't add a free-text note (the picklist value alone
  // is enough signal).
  let cautionToCreate: { note: string; severity: "info" | "warning" | "danger" } | null = null;
  if (body.caution?.note?.trim()) {
    cautionToCreate = {
      note: body.caution.note.trim(),
      severity: (body.caution.severity as "info" | "warning" | "danger") || "warning",
    };
  } else if (reason === "suspected_fake_booking") {
    cautionToCreate = {
      note: `Suspected fake booking — ${booking.booking_number} (${booking.booking_date} ${booking.start_time}–${booking.end_time}).${details ? " " + details : ""}`,
      severity: "danger",
    };
  }

  if (cautionToCreate && booking.lead_id) {
    await supabase.from("lead_cautions").insert({
      lead_id: booking.lead_id,
      booking_id: id,
      note: cautionToCreate.note,
      severity: cautionToCreate.severity,
      created_by: dbUser.id,
    });
  }

  // ── 5. Optional refund request (pending_approval) ───────────────
  let refundRequestId: string | null = null;
  if (wantsRefund && refundReq) {
    const { data: rr, error: rrErr } = await supabase
      .from("refund_requests")
      .insert({
        booking_id: id,
        amount_requested: Number(refundReq.amount),
        reason: refundReq.reason,
        details: (refundReq.details as string | undefined)?.trim() || null,
        status: "pending_approval",
        requested_by: dbUser.id,
      })
      .select("id")
      .single();
    if (rrErr) {
      // Don't fail the cancel — log and surface; staff can re-submit
      // the refund request from the booking detail page.
      console.error("[cancel] refund_request insert failed:", rrErr.message);
    } else {
      refundRequestId = rr.id;
    }
  }

  // ── 6. Audit ────────────────────────────────────────────────────
  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "confirmed", new: "cancelled" },
      cancellation_reason: { old: null, new: reason },
      cancellation_details: { old: null, new: details },
      gst_invoice_required: { old: false, new: gstInvoiceRequired },
      caution_created: { old: null, new: cautionToCreate ? cautionToCreate.severity : null },
      refund_request_created: { old: null, new: refundRequestId },
    },
  });

  return NextResponse.json({
    data: updated,
    refund_request_id: refundRequestId,
    caution_created: !!cautionToCreate,
    gst_invoice_required: gstInvoiceRequired,
    // Ruijie codes released but NOT switched off (no revocation API). Staff
    // must be told, or they'll assume cancelling cut the guest's internet.
    vouchers_still_live: sideEffects.vouchersStillLive,
  });
}

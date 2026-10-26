import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { maybeCreateBookingGstTask } from "@/lib/booking-gst-task";
import { executeBookingCancellationSideEffects } from "@/lib/booking-cancel";
import { recordDeviation } from "@/lib/process-deviations";
import {
  BOOKING_LATE_CLOSE_OUT,
  closeOutDecision,
  validateCloseOut,
} from "@/lib/process-registry";

export const dynamic = "force-dynamic";

const CLOSE_OUT_ROLES = ["admin", "manager", "floor_manager", "sales_rep", "accounts", "fms", "office_admin"];

/**
 * POST /api/bookings/[id]/close-out
 *
 * Completes a booking that was never checked in or out on its day. The
 * customer used the room (or didn't come) and the app has to catch up: the GST
 * invoice only starts once a booking is checked out, so a missed check-in
 * would otherwise hold up billing indefinitely.
 *
 * This is a sanctioned exception, not a gate. It always goes through, and
 * records who, why and on whose watch in process_deviations, which is what
 * the Staff exceptions page reads for coaching.
 *
 *   used     — billed as booked. check_in_at / check_out_at stay empty so
 *              reports can tell assumed usage from real usage. No overtime.
 *              Payment is untouched: an unpaid walk-in stays in Pending
 *              Collection, and the GST task follows once it is verified.
 *   no_show  — the customer never came. Same effects as the No Show button.
 *
 * Extra charges are added before closing, from the booking's Add charge
 * section, which is locked once the booking is closed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });
  if (!CLOSE_OUT_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = validateCloseOut(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.value;

  const admin = createAdminClient();

  const { data: booking } = await admin
    .from("bookings")
    .select("id, booking_number, booking_date, start_time, end_time, status, customer_type, payment_status, total_amount, total_amount_with_gst, location_id, space_id, created_by, usage_charge_id")
    .eq("id", id)
    .maybeSingle();
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const decision = closeOutDecision(booking, new Date());
  if (!decision.allowed) return NextResponse.json({ error: decision.error }, { status: 400 });

  if (booking.status === "checked_in" && input.outcome === "no_show") {
    return NextResponse.json(
      { error: "This customer was checked in, so it can't be a no-show" },
      { status: 400 },
    );
  }

  let accountableId = input.accountable_user_id ?? booking.created_by ?? dbUser.id;
  if (input.accountable_user_id) {
    const { data: chosen } = await admin
      .from("users")
      .select("id")
      .eq("id", input.accountable_user_id)
      .eq("is_active", true)
      .maybeSingle();
    if (!chosen) return NextResponse.json({ error: "That staff member wasn't found" }, { status: 400 });
    accountableId = chosen.id;
  }

  const nowIso = new Date().toISOString();
  const closing: Record<string, unknown> = {
    status: input.outcome === "used" ? "checked_out" : "no_show",
    closed_out_late: true,
    closed_out_at: nowIso,
    closed_out_by: dbUser.id,
  };
  if (input.outcome === "no_show" && ["paid", "prepaid"].includes(booking.payment_status)) {
    // No-show retains the payment, so finance owes the customer a GST invoice
    // for the kept amount, same as the No Show button.
    closing.gst_invoice_required = true;
  }

  const { data: updated, error: updErr } = await admin
    .from("bookings")
    .update(closing)
    .eq("id", id)
    // Two people closing the same booking must not both succeed.
    .eq("status", booking.status)
    .select("id, booking_number, status, closed_out_late")
    .maybeSingle();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (!updated) {
    return NextResponse.json({ error: "This booking was just changed by someone else. Refresh and check again." }, { status: 409 });
  }

  if (input.outcome === "no_show") {
    await executeBookingCancellationSideEffects(admin, {
      bookingId: id,
      customerType: booking.customer_type,
      usageChargeId: booking.usage_charge_id,
      spaceId: booking.space_id,
      bookingDate: booking.booking_date,
      startTime: booking.start_time,
      endTime: booking.end_time,
    }, { skipWaitlistOffer: true });
  } else {
    // A paid booking goes straight to the Tally Inbox. An unpaid one waits:
    // the same helper runs again when its payment is verified.
    await maybeCreateBookingGstTask(admin, id);
  }

  const grandTotal = Number(booking.total_amount_with_gst || booking.total_amount) || 0;
  const dev = await recordDeviation(admin, {
    key: BOOKING_LATE_CLOSE_OUT,
    entityType: "booking",
    entityId: id,
    locationId: booking.location_id,
    dueOn: booking.booking_date,
    recordedBy: dbUser.id,
    accountableUserId: accountableId,
    reasonCode: input.reason_code,
    comment: input.comment,
    amountAtStake: booking.payment_status === "paid" ? 0 : grandTotal,
    details: {
      booking_number: booking.booking_number,
      outcome: input.outcome,
      days_late: decision.daysLate,
      booked_by: booking.created_by,
      previous_status: booking.status,
      payment_status: booking.payment_status,
    },
  });

  void logAudit(admin, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: booking.status, new: closing.status },
      closed_out_late: { old: false, new: true },
      close_out_reason: { old: null, new: input.reason_code },
      close_out_outcome: { old: null, new: input.outcome },
      accountable_user_id: { old: null, new: accountableId },
      days_late: { old: null, new: decision.daysLate },
    },
  });

  return NextResponse.json({ data: updated, deviation_recorded: dev.ok, days_late: decision.daysLate });
}

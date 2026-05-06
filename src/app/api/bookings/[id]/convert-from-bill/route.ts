/**
 * POST /api/bookings/[id]/convert-from-bill
 *
 * Flips a contract-holder booking out of the "post to monthly invoice" track
 * so it can be collected at the counter immediately.
 *
 * Why: contract members occasionally want to settle a one-off booking on the
 * spot (cash, UPI, card) instead of waiting for it to roll up onto next
 * month's invoice. Without this endpoint finance had to manually waive the
 * usage_charge and edit the booking — error-prone and audit-blind.
 *
 * What it does (atomic-ish — Supabase doesn't expose multi-statement txns
 * over PostgREST, so the writes happen sequentially with status guards):
 *   1. Verifies the booking is contract_holder + payment_status='posted_to_bill'
 *   2. Marks the linked usage_charge as billed + settled_in_booking_id (so
 *      next monthly statement skips it)
 *   3. Flips booking.payment_status to 'pending' so the existing
 *      CollectPaymentDialog can take over
 *   4. Logs both changes in the audit trail
 *
 * The actual payment collection happens via the regular
 * /api/booking-payments flow — this endpoint just clears the runway.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function POST(
  _request: NextRequest,
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

  // 1. Load the booking and verify it's eligible.
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, booking_number, customer_type, payment_status, usage_charge_id, contract_id")
    .eq("id", id)
    .single();

  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.customer_type !== "contract_holder") {
    return NextResponse.json(
      { error: "Only contract-holder bookings can be converted from monthly billing" },
      { status: 400 }
    );
  }
  if (booking.payment_status !== "posted_to_bill") {
    return NextResponse.json(
      { error: `Booking is not in posted-to-bill state (current: ${booking.payment_status})` },
      { status: 400 }
    );
  }

  // 2. Settle the linked usage_charge so it falls off the next monthly
  //    statement. Reuses the same primitives as the outstanding-charges
  //    "Collect" flow on past bookings.
  if (booking.usage_charge_id) {
    const { data: oldCharge } = await supabase
      .from("usage_charges")
      .select("status, settled_in_booking_id, settled_at")
      .eq("id", booking.usage_charge_id)
      .single();

    if (oldCharge && oldCharge.status === "pending") {
      const { error: chargeErr } = await supabase
        .from("usage_charges")
        .update({
          status: "billed",
          settled_in_booking_id: booking.id,
          settled_at: new Date().toISOString(),
          notes: "Converted from monthly invoice — collected directly via this booking",
        })
        .eq("id", booking.usage_charge_id);

      if (chargeErr) {
        return NextResponse.json(
          { error: "Failed to update linked charge: " + chargeErr.message },
          { status: 500 }
        );
      }

      logAudit(supabase, {
        entityType: "usage_charge",
        entityId: booking.usage_charge_id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          status: { old: oldCharge.status, new: "billed" },
          settled_in_booking_id: { old: oldCharge.settled_in_booking_id, new: booking.id },
          reason: { old: null, new: "convert-from-bill (collect now)" },
        },
      });
    }
  }

  // 3. Flip the booking out of posted-to-bill so the counter-collection
  //    workflow (CollectPaymentDialog → /api/booking-payments) picks it up.
  const { data: updated, error: updateErr } = await supabase
    .from("bookings")
    .update({ payment_status: "pending" })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: "Failed to flip booking status: " + (updateErr?.message || "unknown") },
      { status: 500 }
    );
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      payment_status: { old: "posted_to_bill", new: "pending" },
      reason: { old: null, new: "Contract member chose to pay at counter instead of monthly invoice" },
    },
  });

  return NextResponse.json({ data: updated });
}

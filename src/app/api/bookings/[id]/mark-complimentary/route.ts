/**
 * PATCH /api/bookings/[id]/mark-complimentary
 *
 * Post-hoc "this should have been complimentary" action — handles the
 * case where the booking was created with a real total but later
 * reclassified as a comp (e.g., manager goodwill after a service
 * issue, or aggregator demo that wasn't flagged at booking time).
 *
 * Effect:
 *   - Sets total_amount = 0, gst_amount = 0, total_amount_with_gst = 0
 *     (the comp is FULL — no partial comps via this endpoint; for a
 *     partial comp, refund the difference via the refund-request flow)
 *   - Sets payment_status = 'waived'
 *   - Captures complimentary_reason + complimentary_details
 *
 * Refuses to run if:
 *   - The booking is already cancelled
 *   - Payment was already collected (verified booking_payments exist)
 *     — that's a refund situation, not a comp; staff should issue a
 *     refund first then come back to this if needed
 *
 * Authorisation: admin / manager / floor_manager. Floor managers can
 * use this for the routine cases they encounter; admin/manager keep
 * an eye on the audit trail.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const STAFF_ROLES = new Set(["admin", "manager", "floor_manager"]);
const VALID_REASONS = new Set([
  "manager_goodwill", "aggregator_demo", "staff_use",
  "event_partnership", "other",
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !STAFF_ROLES.has(dbUser.role)) {
    return NextResponse.json(
      { error: "Floor manager / manager / admin access required" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const reason = body.reason as string | undefined;
  const details = (body.details as string | undefined)?.trim() || null;

  if (!reason || !VALID_REASONS.has(reason)) {
    return NextResponse.json(
      { error: "reason is required (must be a valid picklist value)" },
      { status: 400 }
    );
  }
  if (reason === "other" && !details) {
    return NextResponse.json(
      { error: "details required when reason is 'other'" },
      { status: 400 }
    );
  }

  const { data: booking } = await supabase
    .from("bookings")
    .select("id, status, payment_status, total_amount, gst_amount, total_amount_with_gst")
    .eq("id", id)
    .single();
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.status === "cancelled") {
    return NextResponse.json(
      { error: "Cannot comp a cancelled booking" },
      { status: 400 }
    );
  }

  // Refuse if money has been collected — comp + previously-collected
  // payment is a refund situation, not a clean comp. Force staff to
  // route via the refund flow.
  const { data: paidPayments } = await supabase
    .from("booking_payments")
    .select("id, amount")
    .eq("booking_id", id)
    .eq("status", "verified");
  const totalCollected = (paidPayments || []).reduce((s, p) => s + Number(p.amount), 0);
  if (totalCollected > 0) {
    return NextResponse.json(
      {
        error: `Cannot mark complimentary — ₹${totalCollected.toFixed(2)} has already been collected. Issue a refund via the cancel-with-refund flow first, then come back if still needed.`,
      },
      { status: 400 }
    );
  }

  // Apply the comp: zero the totals, flag waived, capture reason.
  const { data: updated, error: updateErr } = await supabase
    .from("bookings")
    .update({
      total_amount: 0,
      gst_amount: 0,
      total_amount_with_gst: 0,
      payment_status: "waived",
      complimentary_reason: reason,
      complimentary_details: details,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: "Failed to mark complimentary: " + (updateErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      payment_status: { old: booking.payment_status, new: "waived" },
      total_amount: { old: booking.total_amount, new: 0 },
      total_amount_with_gst: { old: booking.total_amount_with_gst, new: 0 },
      complimentary_reason: { old: null, new: reason },
      complimentary_details: { old: null, new: details },
    },
  });

  return NextResponse.json({ data: updated });
}

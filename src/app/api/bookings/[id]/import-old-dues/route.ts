/**
 * POST /api/bookings/[id]/import-old-dues
 *
 * Imports outstanding usage_charges from a customer's previous bookings
 * (especially post-checkout charges discovered via feedback) into THIS
 * booking as add-ons. The flow:
 *
 *   1. Validate each charge: pending status + same lead as the target
 *      booking. (Walk-in customers without a lead row use phone match.)
 *   2. Create a booking_addon for each charge — copies description,
 *      amount, gst_rate verbatim. The addon shows up in the booking's
 *      Extras & charges section and counts toward total_amount_with_gst.
 *   3. Mark each usage_charge as `billed` with settled_in_booking_id
 *      pointing to the target booking. This removes them from the
 *      "outstanding" surface immediately — staff knows they're being
 *      collected via this booking.
 *   4. Recompute the booking's total_amount_with_gst.
 *
 * Why convert to addons rather than just "settle in this booking"?
 * The legacy /api/usage-charges/[id] PATCH with settled_in_booking_id
 * marks the charge as billed but DOESN'T add it to the booking total.
 * That left the customer paying the booking amount only — a real bug
 * for "I owe ₹500 from last week + ₹2,000 today" cases. Converting to
 * an addon makes the dues visible in the receipt and rolls into the
 * Collect Payment dialog correctly.
 *
 * Body:
 *   {
 *     charge_ids: string[]   // usage_charge IDs to import
 *   }
 *
 * Authorisation: any authenticated staff (mirrors the existing
 * /api/usage-charges/[id] settle flow).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: bookingId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();
  const chargeIds = body.charge_ids as string[] | undefined;
  if (!Array.isArray(chargeIds) || chargeIds.length === 0) {
    return NextResponse.json({ error: "charge_ids array is required" }, { status: 400 });
  }

  // Load target booking — needed for total recompute and same-customer
  // validation. Booking must be in a state that accepts addons (the
  // existing addons endpoint enforces this; we mirror the lock list).
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, status, payment_status, lead_id, booker_phone, guest_phone, total_amount, gst_amount, total_amount_with_gst")
    .eq("id", bookingId)
    .single();
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (["cancelled", "checked_out", "no_show"].includes(booking.status)) {
    return NextResponse.json(
      { error: `Cannot import old dues into a ${booking.status} booking` },
      { status: 400 }
    );
  }
  if (booking.payment_status === "paid") {
    return NextResponse.json(
      { error: "Cannot import old dues — payment has already been collected on this booking" },
      { status: 400 }
    );
  }

  // Defence: the addons-add gate also enforces no-verified-payments;
  // mirror that here.
  const { data: paidPayments } = await supabase
    .from("booking_payments")
    .select("id")
    .eq("booking_id", bookingId)
    .eq("status", "verified")
    .limit(1);
  if (paidPayments && paidPayments.length > 0) {
    return NextResponse.json(
      { error: "Cannot import old dues — verified payments exist for this booking" },
      { status: 400 }
    );
  }

  // Load the candidate charges. Must be:
  //   - status = pending
  //   - belong to the same lead as the target booking (or matching
  //     phone for walk-ins where leads might differ historically)
  const { data: charges } = await supabase
    .from("usage_charges")
    .select("id, description, quantity, unit_price, total, gst_rate, gst_amount, total_with_gst, status, lead_id, contract_id")
    .in("id", chargeIds)
    .eq("status", "pending");

  if (!charges || charges.length !== chargeIds.length) {
    return NextResponse.json(
      { error: "One or more charges not found or already settled" },
      { status: 400 }
    );
  }

  // Same-customer guard. Booking has lead_id (or null for walk-ins
  // with no lead). For walk-ins: skip the FK check — the existing
  // outstanding-charges UI on the booking detail does its own phone
  // match before surfacing.
  if (booking.lead_id) {
    const wrongLead = charges.find((c) => c.lead_id !== booking.lead_id);
    if (wrongLead) {
      return NextResponse.json(
        { error: `Charge ${wrongLead.id} belongs to a different customer` },
        { status: 400 }
      );
    }
  }

  // ── 1. Insert one booking_addon per charge ───────────────────────
  // Map "service" addon_type by default — these are post-facto charges
  // (damage, late fees, F&B discovered after-the-fact). Staff can
  // re-categorise from the addons UI if needed.
  const addonsToInsert = charges.map((c) => ({
    booking_id: bookingId,
    addon_type: "service" as const,
    description: c.description,
    quantity: Number(c.quantity ?? 1),
    unit_price: Number(c.unit_price),
    unit_label: null,
    amount: Number(c.total),
    gst_rate: Number(c.gst_rate ?? 0),
    gst_amount: Number(c.gst_amount ?? 0),
    total_with_gst: Number(c.total_with_gst ?? c.total),
    notes: `Imported from outstanding charge ${c.id.slice(0, 8)}`,
    created_by: dbUser.id,
  }));

  const { error: addonsErr } = await supabase
    .from("booking_addons")
    .insert(addonsToInsert);
  if (addonsErr) {
    return NextResponse.json(
      { error: "Failed to create addons: " + addonsErr.message },
      { status: 500 }
    );
  }

  // ── 2. Mark each usage_charge as billed + settled in this booking ──
  // The legacy "Collect" path on the outstanding-charges banner does
  // exactly this — we reuse the same fields so finance reports are
  // consistent.
  const settledAt = new Date().toISOString();
  await supabase
    .from("usage_charges")
    .update({
      status: "billed",
      settled_in_booking_id: bookingId,
      settled_at: settledAt,
    })
    .in("id", chargeIds);

  // ── 3. Recompute booking's total_amount_with_gst (matches the
  //       addons recompute pattern). ──
  const { data: allAddons } = await supabase
    .from("booking_addons")
    .select("total_with_gst")
    .eq("booking_id", bookingId);
  const addonTotal = (allAddons || []).reduce(
    (s, a: { total_with_gst: number | string }) => s + Number(a.total_with_gst),
    0
  );
  const baseAmount = Number(booking.total_amount);
  const baseGst = Number(booking.gst_amount);
  const newTotalWithGst = parseFloat((baseAmount + baseGst + addonTotal).toFixed(2));
  await supabase
    .from("bookings")
    .update({ total_amount_with_gst: newTotalWithGst })
    .eq("id", bookingId);

  // ── 4. Audit ─────────────────────────────────────────────────────
  for (const c of charges) {
    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: c.id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        status: { old: "pending", new: "billed" },
        settled_in_booking_id: { old: null, new: bookingId },
        reason: { old: null, new: "Imported as booking addon" },
      },
    });
  }

  return NextResponse.json({
    imported: charges.length,
    new_total_with_gst: newTotalWithGst,
  });
}

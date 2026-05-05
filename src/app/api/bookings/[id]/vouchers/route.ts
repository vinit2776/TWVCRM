/**
 * POST /api/bookings/[id]/vouchers
 *
 * On-demand voucher issuance for contract-holder bookings where guests are
 * invited to a conference room session. Staff click "Request WiFi Vouchers"
 * on the booking detail page; this endpoint issues ceil(num_attendees / 2)
 * vouchers (or 1 if num_attendees is not set) and returns the codes.
 *
 * Walk-in / guest bookings get vouchers automatically at creation time;
 * this route is intentionally limited to contract_holder bookings only.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Fetch booking with space for location context
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, booking_date, customer_type, num_attendees, location_id, lead_id, contract_id, guest_email, duration_hours, status")
    .eq("id", id)
    .single();

  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // TypeScript narrowing — booking is non-null from here
  const bk = booking;

  if (bk.customer_type !== "contract_holder") {
    return NextResponse.json(
      { error: "Vouchers are issued automatically for walk-in and guest bookings" },
      { status: 400 }
    );
  }

  if (!["confirmed", "checked_in"].includes(bk.status)) {
    return NextResponse.json(
      { error: "Vouchers can only be issued for confirmed or checked-in bookings" },
      { status: 400 }
    );
  }

  // Check if vouchers have already been issued for this booking
  const { data: existing } = await supabase
    .from("voucher_issuances")
    .select("id")
    .eq("booking_id", id)
    .eq("is_active", true);

  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: "Vouchers have already been issued for this booking" },
      { status: 409 }
    );
  }

  const numAttendeesInt = bk.num_attendees ? Math.max(1, Number(bk.num_attendees)) : 1;
  const vouchersNeeded  = Math.ceil(numAttendeesInt / 2);
  const durationHours   = Number(bk.duration_hours || 1);

  const isShortBooking    = durationHours <= 3;
  const preferredValidity = isShortBooking ? 0.125 : 1;
  const fallbackValidity  = isShortBooking ? 1     : null;

  async function fetchVouchers(validity: number, limit: number) {
    const { data } = await supabase
      .from("voucher_repository")
      .select("id, voucher_code, validity_days")
      .eq("status", "available")
      .eq("validity_days", validity)
      .eq("location_id", bk.location_id)
      .limit(limit);
    return data || [];
  }

  let vouchers = await fetchVouchers(preferredValidity, vouchersNeeded);
  if (vouchers.length < vouchersNeeded && fallbackValidity) {
    const stillNeeded = vouchersNeeded - vouchers.length;
    vouchers = [...vouchers, ...(await fetchVouchers(fallbackValidity, stillNeeded))];
  }

  if (vouchers.length === 0) {
    return NextResponse.json(
      { error: "No vouchers available in stock for this location. Please top up the voucher inventory." },
      { status: 422 }
    );
  }

  const now       = new Date();
  const issuedCodes: string[] = [];

  for (let i = 0; i < vouchers.length; i++) {
    const v           = vouchers[i];
    const validityDays = Number(v.validity_days ?? 1);
    const expiryMs    = validityDays < 1
      ? Math.round(validityDays * 24 * 60 * 60 * 1000)
      : 24 * 60 * 60 * 1000;

    await supabase
      .from("voucher_repository")
      .update({
        status: "issued",
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + expiryMs).toISOString(),
      })
      .eq("id", v.id);

    await supabase
      .from("voucher_issuances")
      .insert({
        contract_id: bk.contract_id || null,
        voucher_id: v.id,
        lead_id: bk.lead_id || null,
        booking_id: id,
        seat_number: i + 1,
        issued_by: dbUser.id,
        issued_at: now.toISOString(),
        valid_from: bk.booking_date,
        valid_until: bk.booking_date,
        is_active: true,
        seat_occupant_email: i === 0 ? (bk.guest_email || null) : null,
      });

    issuedCodes.push(v.voucher_code);
  }

  return NextResponse.json({
    issued: issuedCodes.length,
    needed: vouchersNeeded,
    shortfall: Math.max(0, vouchersNeeded - issuedCodes.length),
    codes: issuedCodes,
  });
}

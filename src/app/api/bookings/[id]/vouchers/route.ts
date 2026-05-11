/**
 * POST /api/bookings/[id]/vouchers
 *
 * On-demand WiFi voucher issuance for ANY booking type. Staff click
 * "Issue Vouchers" on the booking detail page and choose how many
 * codes to issue (defaults to ceil(num_attendees / 2)).
 *
 * Body (optional):
 *   { count?: number }  — how many vouchers to issue (1–20).
 *                          Defaults to ceil(num_attendees / 2) or 1.
 *
 * Design rationale:
 *   - Vouchers are no longer auto-issued at booking creation time.
 *   - Staff decides the count based on actual attendees (an 8-seat room
 *     with 2 people only needs 1 code, not 4).
 *   - Already-issued vouchers are additive — calling again issues MORE,
 *     it doesn't re-issue. This lets staff top-up if more guests arrive.
 *   - DB calls are batched: parallel repo updates + single bulk insert.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Fetch booking
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, booking_date, customer_type, num_attendees, location_id, lead_id, contract_id, guest_email, duration_hours, status")
    .eq("id", id)
    .single();

  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  const bk = booking;

  if (!["confirmed", "checked_in"].includes(bk.status)) {
    return NextResponse.json(
      { error: "Vouchers can only be issued for confirmed or checked-in bookings" },
      { status: 400 }
    );
  }

  // Parse optional count from request body
  const body = await request.json().catch(() => ({}));
  const numAttendeesInt = bk.num_attendees ? Math.max(1, Number(bk.num_attendees)) : 1;
  const defaultCount = Math.ceil(numAttendeesInt / 2);
  const requestedCount = body.count != null ? Math.max(1, Math.min(20, Math.floor(Number(body.count)))) : defaultCount;

  const durationHours = Number(bk.duration_hours || 1);
  const isShortBooking = durationHours <= 3;
  const preferredValidity = isShortBooking ? 0.125 : 1;
  const fallbackValidity  = isShortBooking ? 1     : null;

  // Count already-issued vouchers to set correct seat numbers
  const { data: existing } = await supabase
    .from("voucher_issuances")
    .select("id")
    .eq("booking_id", id)
    .eq("is_active", true);
  const alreadyIssued = existing?.length ?? 0;

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

  let vouchers = await fetchVouchers(preferredValidity, requestedCount);
  if (vouchers.length < requestedCount && fallbackValidity) {
    const stillNeeded = requestedCount - vouchers.length;
    vouchers = [...vouchers, ...(await fetchVouchers(fallbackValidity, stillNeeded))];
  }

  if (vouchers.length === 0) {
    return NextResponse.json(
      { error: "No vouchers available in stock for this location. Please top up the voucher inventory." },
      { status: 422 }
    );
  }

  const now = new Date();

  // Batch: parallel repo updates + single bulk issuance insert
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: PromiseLike<any>[] = [
    // Update each voucher's status in parallel
    ...vouchers.map((v) => {
      const validityDays = Number(v.validity_days ?? 1);
      const expiryMs = validityDays < 1
        ? Math.round(validityDays * 24 * 60 * 60 * 1000)
        : 24 * 60 * 60 * 1000;
      return supabase.from("voucher_repository").update({
        status: "issued",
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + expiryMs).toISOString(),
      }).eq("id", v.id);
    }),
    // Single bulk insert for all issuances
    supabase.from("voucher_issuances").insert(
      vouchers.map((v, i) => ({
        contract_id: bk.contract_id || null,
        voucher_id: v.id,
        lead_id: bk.lead_id || null,
        booking_id: id,
        seat_number: alreadyIssued + i + 1,
        issued_by: dbUser.id,
        issued_at: now.toISOString(),
        valid_from: bk.booking_date,
        valid_until: bk.booking_date,
        is_active: true,
        seat_occupant_email: i === 0 && alreadyIssued === 0 ? (bk.guest_email || null) : null,
      }))
    ),
  ];

  await Promise.all(ops);

  return NextResponse.json({
    issued: vouchers.length,
    needed: requestedCount,
    shortfall: Math.max(0, requestedCount - vouchers.length),
    codes: vouchers.map((v) => v.voucher_code),
    total_issued: alreadyIssued + vouchers.length,
  });
}

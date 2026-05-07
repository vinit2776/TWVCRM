/**
 * POST /api/bookings/[id]/defer
 *
 * "Defer remaining time" — partial-checkout carry-forward flow.
 *
 * The customer checked in, used part of their booking, and is leaving
 * early. Instead of forfeiting the unused time or processing a refund,
 * we:
 *   1. check the booking out at "now"
 *   2. issue a booking_credits row for the carry-forward hours, anchored
 *      to the customer's phone, scoped to the booking's location
 *   3. log audit entries for both
 *
 * Authorisation: floor_manager / manager / admin only — the spec gives
 * staff discretion to override the default rounding (floor of unused
 * time) and the default 30-day expiry, so this isn't a sales-rep action.
 *
 * Body:
 *   {
 *     hours_to_carry: number,    // whole hours; staff-overrideable
 *     expires_at?: string,        // ISO date; defaults to issued_at + 30 days
 *     notes?: string,
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

const STAFF_ROLES = new Set(["admin", "manager", "floor_manager"]);

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

  if (!dbUser || !STAFF_ROLES.has(dbUser.role)) {
    return NextResponse.json(
      { error: "Floor manager / manager / admin access required" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const hoursToCarry = Number(body.hours_to_carry);
  const expiresAtBody = body.expires_at as string | undefined;
  const notes = (body.notes as string | undefined)?.trim() || null;

  // Whole-hour rule (per the locked policy). API enforces the integer
  // even when the staff modal pre-fills decimals — the column itself
  // would accept fractional but we're holding the line at this layer.
  if (!Number.isFinite(hoursToCarry) || hoursToCarry < 1 || !Number.isInteger(hoursToCarry)) {
    return NextResponse.json(
      { error: "hours_to_carry must be a whole number ≥ 1" },
      { status: 400 }
    );
  }

  // Load booking + the phone we'll anchor the credit to. Booker phone is
  // the primary; falls back to guest_phone (walk-ins) and lead.phone.
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select(`
      id, booking_number, status, location_id, hourly_rate, duration_hours,
      booker_phone, guest_phone, guest_email, total_amount,
      lead:leads!bookings_lead_id_fkey(id, first_name, last_name, phone, email),
      location:locations!bookings_location_id_fkey(id, name)
    `)
    .eq("id", id)
    .single();

  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.status !== "checked_in") {
    return NextResponse.json(
      { error: `Can only defer a checked-in booking (current status: ${booking.status})` },
      { status: 400 }
    );
  }

  // Don't allow carrying forward more than was booked. The modal floors
  // by default; this catches manual overrides that go past the limit.
  const bookedHours = Number(booking.duration_hours || 0);
  if (hoursToCarry > bookedHours) {
    return NextResponse.json(
      { error: `Cannot carry forward ${hoursToCarry}h — only ${bookedHours}h were booked` },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = booking.lead as any;
  const phone = (booking.booker_phone || booking.guest_phone || lead?.phone || "").trim();
  if (!phone) {
    return NextResponse.json(
      { error: "Cannot issue credit — no phone number on this booking. Edit the booking to add one first." },
      { status: 400 }
    );
  }

  // Derive expiry — default 30 days from now; floor manager+ can override.
  const issuedAt = new Date();
  const expiresAt = expiresAtBody
    ? new Date(expiresAtBody)
    : new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

  if (isNaN(expiresAt.getTime()) || expiresAt <= issuedAt) {
    return NextResponse.json({ error: "expires_at must be a future ISO date" }, { status: 400 });
  }

  const hourlyRate = Number(booking.hourly_rate || 0);

  // 1. Check the booking out at "now". Same shape as the regular
  //    checkout path (see /api/bookings/[id] case "checked_out") minus
  //    the overtime calc — by definition you can't be overtime if you're
  //    leaving early.
  const { error: checkoutErr } = await supabase
    .from("bookings")
    .update({
      status: "checked_out",
      check_out_at: issuedAt.toISOString(),
      checked_out_by: dbUser.id,
    })
    .eq("id", id);

  if (checkoutErr) {
    return NextResponse.json(
      { error: "Failed to check out booking: " + checkoutErr.message },
      { status: 500 }
    );
  }

  // 2. Issue the credit. The DB CHECK constraints already enforce
  //    hours_used <= hours_total etc.
  const { data: credit, error: creditErr } = await supabase
    .from("booking_credits")
    .insert({
      phone,
      location_id: booking.location_id,
      lead_id: lead?.id ?? null,
      hours_total: hoursToCarry,
      hours_used: 0,
      hourly_rate_snapshot: hourlyRate,
      issued_from_booking_id: id,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active",
      notes,
      issued_by: dbUser.id,
    })
    .select(`
      *,
      location:locations!booking_credits_location_id_fkey(id, name, code),
      lead:leads!booking_credits_lead_id_fkey(id, first_name, last_name, company),
      issued_from_booking:bookings!booking_credits_issued_from_booking_id_fkey(id, booking_number)
    `)
    .single();

  if (creditErr || !credit) {
    // We already checked the booking out — surfacing this error gives
    // the staff a chance to issue the credit manually from the lead
    // profile rather than rolling back (which would re-open the room).
    return NextResponse.json(
      { error: "Booking checked out, but credit issue failed: " + (creditErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  // 3. Email the customer their credit details. Fire-and-forget — a
  //    failed send must not block the on-counter checkout. The receipt
  //    is the customer's source of truth; if email bounces, the credit
  //    is still valid and visible on their next booking.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead2 = booking.lead as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc = booking.location as any;
  const customerEmail = lead2?.email || booking.guest_email || null;
  const customerName = lead2 ? `${lead2.first_name} ${lead2.last_name}` : "Guest";
  const locationName = loc?.name || "our centre";

  if (customerEmail) {
    const formatExp = expiresAt.toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric", month: "short", year: "numeric",
    });
    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#015E65;padding:20px 32px;">
          <h1 style="color:white;margin:0;font-size:20px;">Time Credit Issued</h1>
          <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">For unused booking time</p>
        </div>
        <div style="padding:28px 32px;">
          <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
          <p style="color:#333;font-size:14px;">Thank you for visiting today. We've saved your unused booking time as a credit you can use on a future visit.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f0faf5;border-radius:6px;">
            <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;width:40%;">Credit</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${hoursToCarry} hour${hoursToCarry !== 1 ? "s" : ""}</td></tr>
            <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Centre</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${locationName}</td></tr>
            <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Valid until</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${formatExp}</td></tr>
            <tr><td style="padding:10px 16px;color:#666;">From booking</td><td style="padding:10px 16px;color:#333;font-family:monospace;">${booking.booking_number}</td></tr>
          </table>
          <p style="color:#333;font-size:13px;">To redeem, just mention your phone number (<strong>${phone}</strong>) when you book your next visit at ${locationName}. Credit applies in whole-hour increments.</p>
          <p style="color:#666;font-size:12px;margin-top:16px;">Note: credits are valid only at ${locationName} and expire on ${formatExp}.</p>
        </div>
        <div style="background:#015E65;padding:14px 32px;text-align:center;">
          <p style="color:rgba(255,255,255,0.85);margin:0;font-size:11px;">The WorkVilla · contact@theworkvilla.com · +91 97910 97900</p>
        </div>
      </div>`;
    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: customerEmail,
      subject: `Time Credit · ${hoursToCarry}h at ${locationName} — The WorkVilla`,
      html,
    }).catch((e) => console.error("[defer email] failed:", e));
  }

  // 4. Audit both events.
  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "checked_in", new: "checked_out" },
      reason: { old: null, new: `Deferred — ${hoursToCarry}h credit issued (#${credit.id})` },
    },
  });
  logAudit(supabase, {
    entityType: "booking_credit",
    entityId: credit.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      hours_total: { old: null, new: hoursToCarry },
      phone: { old: null, new: phone },
      location_id: { old: null, new: booking.location_id },
      issued_from_booking_id: { old: null, new: id },
      expires_at: { old: null, new: expiresAt.toISOString() },
    },
  });

  return NextResponse.json({ data: credit }, { status: 201 });
}

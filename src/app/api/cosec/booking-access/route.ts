import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { provisionBookingAccess } from "@/lib/provision-booking-access";
import { BOOKING_ACCESS_PIN_ROLES } from "@/lib/constants";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";

export const maxDuration = 30; // allow SMTP + COSEC device calls to complete

const schema = z.object({
  booking_id: z.string().uuid(),
});

// Mirrors the booking page, which only offers Generate/Resend PIN for these.
const PROVISIONABLE_STATUSES = ["confirmed", "checked_in"];

/**
 * POST /api/cosec/booking-access
 *
 * Thin HTTP wrapper around provisionBookingAccess().
 * Called manually (e.g. "Resend PIN" button, admin retrigger).
 *
 * Automatic triggers call provisionBookingAccess() directly — no HTTP round-trip.
 *
 * The middleware skips auth for /api/*, so this route checks it itself: each
 * call pushes a fresh door PIN to the entry devices and texts/emails it to the
 * guest. Only the booking's creator or a BOOKING_ACCESS_PIN_ROLES user may call
 * it, and only for a confirmed or checked-in booking.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, is_active")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser || dbUser.is_active === false) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const bookingId = parsed.data.booking_id;

  const { data: booking } = await supabase
    .from("bookings")
    .select("id, status, created_by")
    .eq("id", bookingId)
    .single();
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const isPinRole = (BOOKING_ACCESS_PIN_ROLES as readonly string[]).includes(dbUser.role);
  if (!isPinRole && booking.created_by !== dbUser.id) {
    return NextResponse.json(
      { error: "Only the booking's creator or a manager can issue its access PIN" },
      { status: 403 },
    );
  }

  if (!PROVISIONABLE_STATUSES.includes(booking.status)) {
    return NextResponse.json(
      { error: `Cannot issue an access PIN for a ${booking.status} booking` },
      { status: 409 },
    );
  }

  const result = await provisionBookingAccess(bookingId);

  if (!result.ok && result.error === "Booking not found") {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: bookingId,
    action: "update",
    performedBy: dbUser.id,
    changes: { access_pin: { old: null, new: result.ok ? "[reissued manually]" : "[manual reissue failed]" } },
  });

  // The PIN itself stays out of the response; the booking page reads it from
  // GET /api/bookings/[id], which is already behind auth.
  const { pin: _pin, ...safeResult } = result;
  return NextResponse.json(safeResult);
}

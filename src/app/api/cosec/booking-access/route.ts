import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { provisionBookingAccess } from "@/lib/provision-booking-access";
import { zodErrorResponse } from "@/lib/validations";

export const maxDuration = 30; // allow SMTP + COSEC device calls to complete

const schema = z.object({
  booking_id: z.string().uuid(),
});

/**
 * POST /api/cosec/booking-access
 *
 * Thin HTTP wrapper around provisionBookingAccess().
 * Called manually (e.g. "Resend PIN" button, admin retrigger).
 *
 * Automatic triggers call provisionBookingAccess() directly — no HTTP round-trip.
 *
 * Safe to call multiple times — idempotent via upsert.
 */
export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const result = await provisionBookingAccess(parsed.data.booking_id);

  if (!result.ok && result.error === "Booking not found") {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  return NextResponse.json(result);
}

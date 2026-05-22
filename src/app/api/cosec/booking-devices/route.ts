import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/cosec/booking-devices?booking_id=...
 *
 * Returns the COSEC devices that were provisioned for a specific booking.
 * Used by the booking detail page to show which access points were activated.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bookingId = request.nextUrl.searchParams.get("booking_id");
  if (!bookingId) return NextResponse.json({ error: "booking_id required" }, { status: 400 });

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("cosec_access_users")
    .select("id, valid_until, device:cosec_devices(id, label, device_category)")
    .eq("entity_id", bookingId)
    .eq("user_type", "booking");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}

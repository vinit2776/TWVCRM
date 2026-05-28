import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/cosec/access-logs?booking_id=<uuid>
 *
 * Returns all access_logs rows for a given booking, ordered by event_time ASC.
 * Joins cosec_devices for a human-readable label.
 *
 * Only authenticated users can read; writes are service-role only (cron).
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bookingId = request.nextUrl.searchParams.get("booking_id");
  if (!bookingId) return NextResponse.json({ error: "booking_id required" }, { status: 400 });

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("access_logs")
    .select("id, direction, event_time, device:cosec_devices(id, label, device_code, device_category)")
    .eq("entity_id", bookingId)
    .order("event_time", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}

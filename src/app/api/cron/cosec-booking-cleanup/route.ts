import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { deleteUserFromDevice } from "@/lib/cosec";

/**
 * GET /api/cron/cosec-booking-cleanup
 *
 * Runs every 30 minutes. Finds walk-in booking access users whose booking
 * has ended and removes them from the device. Handles the intra-day precision
 * gap since validity-date on the device is day-granular.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Find all active booking access users whose booking end_time has passed
  const { data: expired, error } = await admin
    .from("cosec_access_users")
    .select(`
      id,
      cosec_user_id,
      device_id,
      entity_id,
      device:cosec_devices(device_ip, device_port, device_password),
      booking:bookings!cosec_access_users_entity_id_fkey(id, end_time)
    `)
    .eq("user_type", "booking")
    .not("enrollment_status", "eq", "deleted");

  if (error) {
    console.error("[cosec-booking-cleanup] fetch error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!expired || expired.length === 0) {
    return NextResponse.json({ message: "Nothing to clean up", deleted: 0 });
  }

  let deleted = 0;
  const errors: string[] = [];

  for (const row of expired) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const booking = row.booking as any;
    if (!booking?.end_time || booking.end_time > now) continue; // still active

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dev = row.device as any;
    if (!dev) continue;

    const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

    try {
      await deleteUserFromDevice(device, row.cosec_user_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${row.cosec_user_id}: ${msg}`);
      continue;
    }

    await admin
      .from("cosec_access_users")
      .update({
        enrollment_status: "deleted",
        deleted_at: now,
        updated_at: now,
      })
      .eq("id", row.id);

    deleted++;
  }

  return NextResponse.json({ ok: true, deleted, errors });
}

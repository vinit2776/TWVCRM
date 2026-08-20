import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { deleteUserFromDevice } from "@/lib/cosec";
import { withCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/cron/cosec-booking-cleanup
 *
 * Runs every 30 minutes. Finds walk-in booking access users whose booking
 * has ended and removes them from the device. Acts as a safety-net fallback
 * for the immediate cleanup that now fires on checkout — catches any cases
 * where that call failed (device timeout, etc.).
 *
 * entity_id is polymorphic (no FK to bookings), so we fetch booking end_times
 * in a separate query rather than using a PostgREST join.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();
  // IST clock time for end_time comparison (stored as "HH:MM:SS" local time)
  const istTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());

  // 1. All active booking-type enrollments
  const { data: rows, error } = await admin
    .from("cosec_access_users")
    .select("id, cosec_user_id, entity_id, device:cosec_devices(device_ip, device_port, device_password)")
    .eq("user_type", "booking")
    .not("enrollment_status", "in", "(deleted,blocked)");

  if (error) {
    console.error("[cosec-booking-cleanup] fetch error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({ message: "Nothing to clean up", deleted: 0 });
  }

  // 2. Fetch booking end_times for these entity_ids
  const bookingIds = rows.map(r => r.entity_id);
  const { data: bookings } = await admin
    .from("bookings")
    .select("id, end_time, booking_date")
    .in("id", bookingIds);

  const bookingMap = new Map((bookings ?? []).map(b => [b.id, b]));

  let deleted = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const booking = bookingMap.get(row.entity_id);
    if (!booking) continue;

    // booking_date is "YYYY-MM-DD", end_time is "HH:MM:SS" (IST clock time)
    const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const bookingDate = booking.booking_date as string;
    const endTime = booking.end_time as string;

    // Skip if booking is today and hasn't ended yet
    if (bookingDate === todayIST && endTime > istTime) continue;
    // Skip if booking is in the future (shouldn't happen but be safe)
    if (bookingDate > todayIST) continue;

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
      .update({ enrollment_status: "deleted", deleted_at: now, updated_at: now })
      .eq("id", row.id);

    deleted++;
  }

  return NextResponse.json({ ok: true, deleted, errors });
}

export const GET = withCronHealth("cron/cosec-booking-cleanup", handler);

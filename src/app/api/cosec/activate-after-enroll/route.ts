import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { setUserActive } from "@/lib/cosec";

/**
 * POST /api/cosec/activate-after-enroll
 *
 * Internal — called by the cosec-events cron when enrollment event detected.
 * Sets user-active=1 on the device so they can now use their enrolled biometric.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { access_user_id, device_id } = await request.json();
  if (!access_user_id || !device_id) {
    return NextResponse.json({ error: "Missing access_user_id or device_id" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: row } = await admin
    .from("cosec_access_users")
    .select("cosec_user_id, device:cosec_devices(device_ip, device_port, device_password)")
    .eq("id", access_user_id)
    .single();

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dev = row.device as any;
  const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

  await setUserActive(device, row.cosec_user_id, true);

  await admin
    .from("cosec_access_users")
    .update({ enrollment_status: "biometric_enrolled", updated_at: new Date().toISOString() })
    .eq("id", access_user_id);

  return NextResponse.json({ ok: true });
}

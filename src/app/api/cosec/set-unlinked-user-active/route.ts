import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { setUserActive } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const schema = z.object({
  device_id: z.string().uuid(),
  cosec_user_id: z.string().min(1),
  active: z.boolean(),
});

/**
 * POST /api/cosec/set-unlinked-user-active
 *
 * Enable or disable a user that exists on a COSEC device but has no
 * cosec_access_users record in the CRM. Used for legacy PIN audit cleanup.
 * Admin / manager only.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: dbUser } = await admin
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { device_id, cosec_user_id, active } = parsed.data;

  const { data: device } = await admin
    .from("cosec_devices")
    .select("device_ip, device_port, device_password")
    .eq("id", device_id)
    .single();

  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  try {
    await setUserActive(
      { ip: device.device_ip, port: device.device_port, password: device.device_password },
      cosec_user_id,
      active
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Device error" },
      { status: 422 }
    );
  }

  logAudit(admin, {
    entityType: "cosec_device",
    entityId: device_id,
    action: active ? "enable" : "disable",
    performedBy: user.id,
    changes: { cosec_user_id: { old: null, new: cosec_user_id }, active: { old: !active, new: active } },
  });

  return NextResponse.json({ ok: true });
}

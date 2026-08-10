import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { openDoor } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const schema = z.object({
  device_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { device_id } = parsed.data;

  const admin = createAdminClient();
  const { data: deviceRow, error: deviceErr } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password, location_id")
    .eq("id", device_id)
    .eq("is_enabled", true)
    .single();

  if (deviceErr || !deviceRow) {
    return NextResponse.json({ error: "Device not found or disabled" }, { status: 404 });
  }

  const device = {
    ip: deviceRow.device_ip,
    port: deviceRow.device_port,
    password: deviceRow.device_password,
  };

  try {
    await openDoor(device);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Door open failed" },
      { status: 422 }
    );
  }

  // Audit — manual door opens must be logged
  logAudit(admin, {
    entityType: "contract",
    entityId: device_id,
    action: "update",
    performedBy: user.id,
    changes: { door_opened: { old: null, new: `Manual open by user at device ${device_id}` } },
  });

  return NextResponse.json({ ok: true });
}

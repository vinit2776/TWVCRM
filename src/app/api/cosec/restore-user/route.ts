import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { setUserActive } from "@/lib/cosec";
import { z } from "zod";

const schema = z.object({
  access_user_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();

  const { data: row } = await admin
    .from("cosec_access_users")
    .select("cosec_user_id, device:cosec_devices(device_ip, device_port, device_password)")
    .eq("id", parsed.data.access_user_id)
    .single();

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dev = row.device as any;
  const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

  try {
    await setUserActive(device, row.cosec_user_id, true);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Device error" }, { status: 422 });
  }

  const now = new Date().toISOString();
  await admin
    .from("cosec_access_users")
    .update({ enrollment_status: "biometric_enrolled", blocked_at: null, updated_at: now })
    .eq("id", parsed.data.access_user_id);

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { pingDevice } from "@/lib/cosec";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const schema = z.object({
  // Test with an existing saved device
  device_id: z.string().uuid().optional(),
  // Or test with raw credentials (before saving)
  device_ip: z.string().min(1).optional(),
  device_port: z.number().int().min(1).max(65535).optional(),
  device_password: z.string().min(1).optional(),
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

  const { device_id, device_ip, device_port, device_password } = parsed.data;

  let device: { ip: string; port: number; password: string };

  if (device_id) {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("cosec_devices")
      .select("device_ip, device_port, device_password")
      .eq("id", device_id)
      .single();
    if (error || !data) {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }
    device = { ip: data.device_ip, port: data.device_port, password: data.device_password };
  } else if (device_ip && device_password) {
    device = { ip: device_ip, port: device_port ?? 80, password: device_password };
  } else {
    return NextResponse.json(
      { error: "Provide either device_id or device_ip + device_password" },
      { status: 400 }
    );
  }

  const result = await pingDevice(device);

  // If testing a saved device, update last_ping state
  if (device_id) {
    const admin = createAdminClient();
    await admin
      .from("cosec_devices")
      .update({ last_ping_at: new Date().toISOString(), last_ping_success: result.ok })
      .eq("id", device_id);
  }

  return NextResponse.json(result);
}

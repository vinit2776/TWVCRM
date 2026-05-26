/**
 * GET /api/unifi/wlan
 * Returns the SSID of the hotspot (open/captive-portal) network from the UniFi device.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUnifiHotspotSsid } from "@/lib/unifi";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ssid = await getUnifiHotspotSsid();
  return NextResponse.json({ ssid });
}

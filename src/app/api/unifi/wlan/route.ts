/**
 * GET /api/unifi/wlan
 * Returns the SSID of the hotspot (open/captive-portal) network from the UniFi device.
 * Query: location_id — which site to ask (falls back to the default console).
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUnifiHotspotSsid, siteConfigForLocationId } from "@/lib/unifi";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Each site names its guest network differently, so the SSID must come from
  // the location's own console, not the default one.
  const locationId = new URL(request.url).searchParams.get("location_id");
  const ssid = await getUnifiHotspotSsid(await siteConfigForLocationId(locationId));
  return NextResponse.json({ ssid });
}

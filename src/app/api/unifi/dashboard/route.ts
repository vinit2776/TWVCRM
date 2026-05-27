/**
 * GET /api/unifi/dashboard
 *
 * Returns a summary of UniFi network health: internet status, live clients, and today's stats.
 * Auth required (any authenticated role).
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiHealthSubsystem {
  subsystem: string;
  status: string;
  "tx_bytes-r"?: number;
  "rx_bytes-r"?: number;
  latency?: number;
  uptime?: number;
  isp_name?: string;
  xput_up?: number;
  xput_down?: number;
  uptime_stats?: Record<string, unknown>;
}

interface UnifiClient {
  mac: string;
  essid?: string;
  is_guest?: boolean;
}

interface UnifiDailyStat {
  time: number;
  num_sta?: number;
  wlan_bytes?: number;
  "wan-tx_bytes"?: number;
  "wan-rx_bytes"?: number;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  // Resolve site config from location row (falls back to env-var defaults)
  const locationId = request.nextUrl.searchParams.get("location_id");
  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations")
      .select("unifi_console_id, unifi_site_id")
      .eq("id", locationId)
      .single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  try {
    const now = Date.now();
    const start = now - 24 * 60 * 60 * 1000;

    const reportBody = JSON.stringify({
      attrs: ["num_sta", "wlan_bytes", "wan-tx_bytes", "wan-rx_bytes"],
      start,
      end: now,
    });

    const [healthData, clients, dailyStats] = await Promise.all([
      cachedUnifiRequest<UnifiHealthSubsystem[]>("/stat/health", {}, 30, siteCfg),
      cachedUnifiRequest<UnifiClient[]>("/stat/sta", {}, 30, siteCfg),
      cachedUnifiRequest<UnifiDailyStat[]>("/stat/report/daily.site", {
        method: "POST",
        body: reportBody,
      }, 30, siteCfg),
    ]);

    const wan = healthData.find((s) => s.subsystem === "wan");
    const wan2 = healthData.find((s) => s.subsystem === "wan2");

    const internet = {
      status: wan?.status ?? "unknown",
      tx_bytes_r: wan?.["tx_bytes-r"] ?? 0,
      rx_bytes_r: wan?.["rx_bytes-r"] ?? 0,
      latency: wan?.latency ?? 0,
      uptime: wan?.uptime ?? 0,
      isp_name: wan?.isp_name ?? null,
      xput_up: wan?.xput_up ?? 0,
      xput_down: wan?.xput_down ?? 0,
      uptime_stats: {
        wan: wan?.uptime_stats ?? null,
        wan2: wan2?.uptime_stats ?? null,
      },
    };

    const guest = clients.filter(
      (c) => c.is_guest === true || (c.essid && c.essid.toLowerCase().includes("guest"))
    ).length;
    const staff = clients.length - guest;

    const live_clients = { total: clients.length, guest, staff };

    // Use the last bucket for today's stats
    const lastBucket = dailyStats[dailyStats.length - 1];
    const today = {
      unique_devices: lastBucket?.num_sta ?? 0,
      wlan_bytes: lastBucket?.wlan_bytes ?? 0,
      wan_tx: lastBucket?.["wan-tx_bytes"] ?? 0,
      wan_rx: lastBucket?.["wan-rx_bytes"] ?? 0,
    };

    return NextResponse.json({ internet, live_clients, today });
  } catch (err) {
    console.error("[api/unifi/dashboard] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

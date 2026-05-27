/**
 * GET /api/unifi/stats?range=daily|hourly&days=7
 *
 * Returns time-series traffic and client data from UniFi.
 * Auth required (any authenticated role).
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiStatBucket {
  time: number;
  num_sta?: number;
  wlan_bytes?: number;
  "wan-tx_bytes"?: number;
  "wan-rx_bytes"?: number;
}

function formatDailyLabel(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
  // e.g. "Mon 26"
}

function formatHourlyLabel(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  return `${hh}:00`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range") === "hourly" ? "hourly" : "daily";
  const daysParam = parseInt(searchParams.get("days") ?? "7", 10);
  const days = Math.min(Math.max(isNaN(daysParam) ? 7 : daysParam, 1), 90);

  const locationId = searchParams.get("location_id");
  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", locationId).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  const now = Date.now();
  const start = range === "hourly" ? now - 24 * 60 * 60 * 1000 : now - days * 86400 * 1000;

  const endpoint = range === "hourly" ? "/stat/report/hourly.site" : "/stat/report/daily.site";

  try {
    const statsBody = JSON.stringify({
      attrs: ["num_sta", "wlan_bytes", "wan-tx_bytes", "wan-rx_bytes"],
      start,
      end: now,
    });

    const buckets = await cachedUnifiRequest<UnifiStatBucket[]>(endpoint, {
      method: "POST",
      body: statsBody,
    }, 300, siteCfg);

    const data = buckets.map((b) => ({
      time: b.time,
      label: range === "hourly" ? formatHourlyLabel(b.time) : formatDailyLabel(b.time),
      num_sta: b.num_sta ?? 0,
      wlan_bytes: b.wlan_bytes ?? 0,
      wan_tx: b["wan-tx_bytes"] ?? 0,
      wan_rx: b["wan-rx_bytes"] ?? 0,
    }));

    return NextResponse.json({ data });
  } catch (err) {
    console.error("[api/unifi/stats] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

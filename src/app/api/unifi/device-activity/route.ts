/**
 * GET /api/unifi/device-activity?mac=<mac>&location_id=<id>
 *
 * Returns live client status (if currently connected) + session history for a device.
 * Auth required: admin, manager, it_manager.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { unifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiClient {
  mac: string;
  hostname?: string;
  ip?: string;
  essid?: string;
  ap_mac?: string;
  signal?: number;
  rssi?: number;
  uptime?: number;
  rx_bytes?: number;
  tx_bytes?: number;
  is_guest?: boolean;
  assoc_time?: number;
  oui?: string;
}

interface UnifiSession {
  mac: string;
  assoc_time: number;   // unix seconds — session start
  duration: number;     // seconds
  rx_bytes: number;
  tx_bytes: number;
  essid?: string;
  ap_mac?: string;
  is_guest?: boolean;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!["admin", "manager", "it_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const mac = searchParams.get("mac");
  const locationId = searchParams.get("location_id");

  if (!mac) return NextResponse.json({ error: "mac is required" }, { status: 400 });

  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", locationId).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  // 30 days back
  const startTs = Math.floor(Date.now() / 1000) - 30 * 86400;

  try {
    const [liveClients, sessions] = await Promise.allSettled([
      unifiRequest<UnifiClient[]>(`/stat/sta/${mac}`, {}, siteCfg),
      unifiRequest<UnifiSession[]>(
        `/stat/session?type=all&mac=${mac}&start=${startTs}`,
        {},
        siteCfg
      ),
    ]);

    const live = liveClients.status === "fulfilled" && liveClients.value.length > 0
      ? (() => {
          const c = liveClients.value[0];
          return {
            connected: true,
            hostname: c.hostname ?? null,
            ip: c.ip ?? null,
            essid: c.essid ?? null,
            ap_mac: c.ap_mac ?? null,
            signal: c.signal ?? null,
            uptime_seconds: c.uptime ?? null,
            rx_bytes: c.rx_bytes ?? null,
            tx_bytes: c.tx_bytes ?? null,
            is_guest: c.is_guest ?? false,
            assoc_time: c.assoc_time ? new Date(c.assoc_time * 1000).toISOString() : null,
          };
        })()
      : { connected: false };

    const sessionData = sessions.status === "fulfilled"
      ? sessions.value
          .sort((a, b) => b.assoc_time - a.assoc_time)
          .slice(0, 50)
          .map((s) => ({
            start: new Date(s.assoc_time * 1000).toISOString(),
            duration_seconds: s.duration,
            rx_bytes: s.rx_bytes,
            tx_bytes: s.tx_bytes,
            essid: s.essid ?? null,
            ap_mac: s.ap_mac ?? null,
            is_guest: s.is_guest ?? false,
          }))
      : [];

    return NextResponse.json({ live, sessions: sessionData });
  } catch (err) {
    console.error("[api/unifi/device-activity] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

/**
 * GET /api/unifi/access-points
 *
 * Returns all UniFi network devices (APs, switches, etc.) with status and health data.
 * Auth required: admin, manager, it_manager, it_technician, floor_manager.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiDevice {
  _id: string;
  mac?: string;
  name?: string;
  model?: string;
  type?: string;
  state?: number;
  ip?: string;
  uptime?: number;
  version?: string;
  num_sta?: number;
  "user-num_sta"?: number;
  "guest-num_sta"?: number;
  satisfaction?: number;
  "system-stats"?: {
    cpu?: string;
    mem?: string;
  };
  last_seen?: number;
}

function formatUptimeHuman(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const allowed = ["admin", "manager", "it_manager", "it_technician", "floor_manager"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");
  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", locationId).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  try {
    const devices = await cachedUnifiRequest<UnifiDevice[]>("/stat/device", {}, 60, siteCfg);

    const data = devices.map((d) => ({
      _id: d._id,
      mac: d.mac ?? null,
      name: d.name ?? null,
      model: d.model ?? null,
      type: d.type ?? null,
      state: d.state ?? 0,
      status: d.state === 1 ? "online" : "offline",
      ip: d.ip ?? null,
      uptime: d.uptime ?? 0,
      uptime_human: d.uptime ? formatUptimeHuman(d.uptime) : "—",
      version: d.version ?? null,
      num_sta: d.num_sta ?? 0,
      "user-num_sta": d["user-num_sta"] ?? 0,
      "guest-num_sta": d["guest-num_sta"] ?? 0,
      satisfaction: d.satisfaction ?? null,
      cpu_pct: d["system-stats"]?.cpu ? parseFloat(d["system-stats"].cpu) : null,
      mem_pct: d["system-stats"]?.mem ? parseFloat(d["system-stats"].mem) : null,
      last_seen: d.last_seen ?? null,
    }));

    return NextResponse.json({ data });
  } catch (err) {
    console.error("[api/unifi/access-points] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

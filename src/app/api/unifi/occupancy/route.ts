/**
 * GET /api/unifi/occupancy
 *
 * Returns the current list of connected Wi-Fi clients.
 * MAC addresses are anonymized for non-admin roles (last 4 chars only).
 * Auth required: admin, manager, sales_rep, floor_manager, office_admin, it_manager, it_technician.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiSta {
  mac: string;
  hostname?: string;
  ip?: string;
  essid?: string;
  signal?: number;
  uptime?: number;
  tx_bytes?: number;
  rx_bytes?: number;
  oui?: string;
  last_seen?: number;
  is_guest?: boolean;
}

function anonymizeMac(mac: string): string {
  // Keep last two octets visible: ••:••:••:••:XX:XX
  const parts = mac.split(":");
  if (parts.length !== 6) return mac;
  return `••:••:••:••:${parts[4]}:${parts[5]}`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const allowed = ["admin", "manager", "sales_rep", "floor_manager", "office_admin", "it_manager", "it_technician"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const isAdmin = dbUser.role === "admin";

  const locationId = request.nextUrl.searchParams.get("location_id");
  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", locationId).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  try {
    const clients = await cachedUnifiRequest<UnifiSta[]>("/stat/sta", {}, 30, siteCfg);

    const data = clients.map((c) => ({
      mac: isAdmin ? c.mac : anonymizeMac(c.mac),
      hostname: c.hostname ?? null,
      ...(isAdmin ? { ip: c.ip ?? null } : {}),
      essid: c.essid ?? null,
      signal: c.signal ?? null,
      uptime: c.uptime ?? null,
      tx_bytes: c.tx_bytes ?? null,
      rx_bytes: c.rx_bytes ?? null,
      oui: c.oui ?? null,
      last_seen: c.last_seen ?? null,
    }));

    const guest = clients.filter(
      (c) => c.essid && c.essid.toLowerCase().includes("clients")
    ).length;
    const staff = clients.length - guest;

    const stats = { total: clients.length, guest, staff };

    return NextResponse.json({ data, stats });
  } catch (err) {
    console.error("[api/unifi/occupancy] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

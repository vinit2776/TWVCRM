/**
 * GET /api/unifi/known-devices?limit=50&search=<string>
 *
 * Returns all known/seen Wi-Fi devices. MAC anonymized for non-admin roles.
 * Auth required: admin, manager, it_manager.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiKnownDevice {
  mac: string;
  hostname?: string;
  name?: string;
  last_seen?: number;
  oui?: string;
  noted?: boolean;
  blocked?: boolean;
  is_guest?: boolean;
}

function anonymizeMac(mac: string): string {
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

  const allowed = ["admin", "manager", "it_manager"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limitParam = parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(isNaN(limitParam) ? 50 : limitParam, 1), 200);
  const search = searchParams.get("search")?.toLowerCase() ?? null;

  const isAdmin = dbUser.role === "admin";

  const locationId = searchParams.get("location_id");
  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", locationId).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  try {
    const devices = await cachedUnifiRequest<UnifiKnownDevice[]>("/stat/alluser", {}, 120, siteCfg);

    let filtered = devices;
    if (search) {
      filtered = devices.filter(
        (d) =>
          (d.hostname?.toLowerCase().includes(search)) ||
          (d.name?.toLowerCase().includes(search))
      );
    }

    const total = filtered.length;
    const data = filtered.slice(0, limit).map((d) => ({
      mac: isAdmin ? d.mac : anonymizeMac(d.mac),
      hostname: d.hostname ?? null,
      name: d.name ?? null,
      // UniFi returns Unix seconds; convert to ISO string for formatDate()
      last_seen: d.last_seen ? new Date(d.last_seen * 1000).toISOString() : null,
      oui: d.oui ?? null,
      noted: d.noted ?? false,
      blocked: d.blocked ?? false,
      is_guest: d.is_guest ?? false,
    }));

    return NextResponse.json({ data, total });
  } catch (err) {
    console.error("[api/unifi/known-devices] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

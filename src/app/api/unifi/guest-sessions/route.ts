/**
 * GET /api/unifi/guest-sessions?limit=50&offset=0
 *
 * Returns guest Wi-Fi sessions with voucher codes masked.
 * Auth required: admin, manager, it_manager, it_technician.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiGuestSession {
  mac: string;
  hostname?: string;
  ip?: string;
  code?: string;
  bytes?: number;
  rx_bytes?: number;
  tx_bytes?: number;
  duration?: number;
  start?: number;
  end?: number;
  name?: string;
}

function anonymizeMac(mac: string): string {
  const parts = mac.split(":");
  if (parts.length !== 6) return mac;
  return `••:••:••:••:${parts[4]}:${parts[5]}`;
}

function maskVoucherCode(code: string): string {
  if (code.length <= 4) return code;
  return "•".repeat(code.length - 4) + code.slice(-4);
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const allowed = ["admin", "manager", "it_manager", "it_technician"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limitParam = parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(isNaN(limitParam) ? 50 : limitParam, 1), 200);
  const offsetParam = parseInt(searchParams.get("offset") ?? "0", 10);
  const offset = Math.max(isNaN(offsetParam) ? 0 : offsetParam, 0);

  const isAdmin = dbUser.role === "admin";

  const locationId = searchParams.get("location_id");
  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", locationId).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  try {
    // 7-day window: pass _start epoch to limit response size
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const sessions = await cachedUnifiRequest<UnifiGuestSession[]>(
      `/stat/guest?_start=${sevenDaysAgo}`,
      {},
      60,
      siteCfg
    );

    const total = sessions.length;
    const page = sessions.slice(offset, offset + limit);

    const data = page.map((s) => ({
      mac: isAdmin ? s.mac : anonymizeMac(s.mac),
      hostname: s.hostname ?? null,
      voucher_code: s.code ? maskVoucherCode(s.code) : null,
      bytes: s.bytes ?? null,
      rx_bytes: s.rx_bytes ?? null,
      tx_bytes: s.tx_bytes ?? null,
      duration: s.duration ?? null,
      start: s.start ?? null,
      end: s.end ?? null,
      name: s.name ?? null,
      ...(isAdmin ? { ip: s.ip ?? null } : {}),
    }));

    return NextResponse.json({ data, total });
  } catch (err) {
    console.error("[api/unifi/guest-sessions] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

/**
 * POST /api/unifi/clients/command
 *
 * Execute a management command on one or more connected/known WiFi clients.
 * Body: { mac: string, cmd, location_id? } — single client (backward compatible)
 *    or { macs: string[], cmd, location_id? } — bulk
 *
 * kick-sta     — disconnect a currently-connected client (they can reconnect)
 * block-sta    — permanently block a MAC from connecting to this site
 * unblock-sta  — lift an existing block
 * unauthorize-guest — revoke hotspot/guest authorisation without blocking
 *
 * Auth required: admin, it_manager.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { unifiRequest, siteConfigFromLocation } from "@/lib/unifi";

const ALLOWED_CMDS = ["block-sta", "unblock-sta", "kick-sta", "unauthorize-guest"] as const;
type ClientCmd = typeof ALLOWED_CMDS[number];

const MAX_BULK = 200;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!["admin", "it_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  let body: { mac?: string; macs?: string[]; cmd?: string; location_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mac, macs, cmd, location_id } = body;
  const macList = macs && macs.length > 0 ? macs : mac ? [mac] : [];
  if (macList.length === 0) {
    return NextResponse.json({ error: "mac or macs is required" }, { status: 400 });
  }
  if (macList.length > MAX_BULK) {
    return NextResponse.json({ error: `Too many clients — max ${MAX_BULK} per request` }, { status: 400 });
  }
  if (!macList.every((m) => typeof m === "string" && m.length > 0)) {
    return NextResponse.json({ error: "All entries in macs must be non-empty strings" }, { status: 400 });
  }
  if (!cmd || !ALLOWED_CMDS.includes(cmd as ClientCmd)) {
    return NextResponse.json(
      { error: `cmd must be one of: ${ALLOWED_CMDS.join(", ")}` },
      { status: 400 }
    );
  }

  let siteCfg = undefined;
  if (location_id) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", location_id).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  const results = await Promise.all(
    macList.map(async (m) => {
      try {
        await unifiRequest(
          "/cmd/stamgr",
          { method: "POST", body: JSON.stringify({ cmd, mac: m }) },
          siteCfg
        );
        return { mac: m, ok: true as const };
      } catch (err) {
        console.error("[api/unifi/clients/command] failed:", m, err);
        return { mac: m, ok: false as const, error: err instanceof Error ? err.message : "Command failed" };
      }
    })
  );

  const allOk = results.every((r) => r.ok);

  // Preserve the original single-client response shape when only one mac was requested.
  if (!macs) {
    const r = results[0];
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
    return NextResponse.json({ ok: true, cmd, mac: r.mac });
  }

  return NextResponse.json({ ok: allOk, cmd, results });
}

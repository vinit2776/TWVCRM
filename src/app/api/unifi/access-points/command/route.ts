/**
 * POST /api/unifi/access-points/command
 *
 * Execute a management command on a UniFi network device (AP, switch, etc.).
 * Body: { mac: string, cmd: "force-provision" | "restart", location_id?: string }
 * Auth required: admin, it_manager only.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { unifiRequest, siteConfigFromLocation } from "@/lib/unifi";

const ALLOWED_CMDS = ["force-provision", "restart"] as const;
type DevCmd = typeof ALLOWED_CMDS[number];

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

  let body: { mac?: string; cmd?: string; location_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mac, cmd, location_id } = body;
  if (!mac || typeof mac !== "string") {
    return NextResponse.json({ error: "mac is required" }, { status: 400 });
  }
  if (!cmd || !ALLOWED_CMDS.includes(cmd as DevCmd)) {
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

  try {
    await unifiRequest(
      "/cmd/devmgr",
      { method: "POST", body: JSON.stringify({ cmd, mac }) },
      siteCfg
    );
    return NextResponse.json({ ok: true, cmd, mac });
  } catch (err) {
    console.error("[api/unifi/access-points/command] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Command failed" },
      { status: 502 }
    );
  }
}

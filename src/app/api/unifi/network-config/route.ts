/**
 * GET /api/unifi/network-config
 *
 * Returns port forwarding rules and WLAN configurations.
 * Auth required: admin, it_manager, it_technician ONLY.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { unifiRequest } from "@/lib/unifi";

interface UnifiPortForward {
  name?: string;
  dst_port?: string | number;
  fwd?: string;
  fwd_port?: string | number;
  proto?: string;
  enabled?: boolean;
}

interface UnifiWlan {
  _id: string;
  name?: string;
  security?: string;
  enabled?: boolean;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const allowed = ["admin", "it_manager", "it_technician"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  try {
    const [portForwardRaw, wlanRaw] = await Promise.all([
      unifiRequest<UnifiPortForward[]>("/list/portforward"),
      unifiRequest<UnifiWlan[]>("/list/wlanconf"),
    ]);

    const port_forwards = portForwardRaw.map((pf) => ({
      name: pf.name ?? null,
      dst_port: pf.dst_port ?? null,
      fwd: pf.fwd ?? null,
      fwd_port: pf.fwd_port ?? null,
      proto: pf.proto ?? null,
      enabled: pf.enabled ?? false,
    }));

    const wlans = wlanRaw.map((w) => ({
      _id: w._id,
      name: w.name ?? null,
      security: w.security ?? null,
      enabled: w.enabled ?? false,
    }));

    return NextResponse.json({ port_forwards, wlans });
  } catch (err) {
    console.error("[api/unifi/network-config] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}

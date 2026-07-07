/**
 * GET /api/unifi/events?location_id=<id>&limit=<n>&include_alarms=true
 *
 * Returns recent site events and alarms from the UniFi controller.
 * Auth required: admin, manager, it_manager, it_technician.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { unifiRequest, siteConfigFromLocation } from "@/lib/unifi";

interface UnifiEvent {
  _id: string;
  key: string;
  msg: string;
  time: number;           // unix seconds
  datetime?: string;
  subsystem?: string;
  ap?: string;
  ap_displayName?: string;
  sw?: string;
  sw_displayName?: string;
  gw?: string;
  gw_displayName?: string;
  user?: string;
  is_negative?: boolean;
  admin?: string;
}

interface UnifiAlarm {
  _id: string;
  key: string;
  msg: string;
  time: number;
  subsystem?: string;
  ap_displayName?: string;
  sw_displayName?: string;
  gw_displayName?: string;
  archived?: boolean;
}

function mapEvent(e: UnifiEvent) {
  const device = e.ap_displayName ?? e.sw_displayName ?? e.gw_displayName ?? null;
  return {
    id: e._id,
    key: e.key,
    msg: e.msg,
    time: new Date(e.time * 1000).toISOString(),
    subsystem: e.subsystem ?? null,
    device,
    device_mac: e.ap ?? e.sw ?? e.gw ?? null,
    client_mac: e.user ?? null,
    is_negative: e.is_negative ?? false,
    type: "event" as const,
  };
}

function mapAlarm(a: UnifiAlarm) {
  const device = a.ap_displayName ?? a.sw_displayName ?? a.gw_displayName ?? null;
  return {
    id: a._id,
    key: a.key,
    msg: a.msg,
    time: new Date(a.time * 1000).toISOString(),
    subsystem: a.subsystem ?? null,
    device,
    device_mac: null,
    client_mac: null,
    is_negative: true,
    archived: a.archived ?? false,
    type: "alarm" as const,
  };
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!["admin", "manager", "it_manager", "it_technician"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10), 500);
  const includeAlarms = searchParams.get("include_alarms") === "true";

  let siteCfg = undefined;
  if (locationId) {
    const { data: loc } = await supabase
      .from("locations").select("unifi_console_id, unifi_site_id").eq("id", locationId).single();
    if (loc) siteCfg = siteConfigFromLocation(loc);
  }

  // Some consoles/proxies don't expose /stat/event or /stat/alarm (404
  // api.err.NotFound) even though /stat/device, /stat/sta, etc. work fine —
  // observed on at least one UDM SE behind the cloud connector proxy. Treat
  // each independently as non-fatal so the tab degrades to "unavailable"
  // instead of hard-failing the whole page.
  let events: ReturnType<typeof mapEvent>[] = [];
  let eventsUnavailable = false;
  try {
    const eventsRaw = await unifiRequest<UnifiEvent[]>(`/stat/event?_limit=${limit}`, {}, siteCfg);
    events = eventsRaw.map(mapEvent);
  } catch (err) {
    console.warn("[api/unifi/events] events unavailable:", err);
    eventsUnavailable = true;
  }

  let alarms: ReturnType<typeof mapAlarm>[] = [];
  let alarmsUnavailable = false;
  if (includeAlarms) {
    try {
      const alarmsRaw = await unifiRequest<UnifiAlarm[]>("/stat/alarm?archived=false", {}, siteCfg);
      alarms = alarmsRaw.map(mapAlarm);
    } catch (err) {
      console.warn("[api/unifi/events] alarms unavailable:", err);
      alarmsUnavailable = true;
    }
  }

  if (eventsUnavailable && alarmsUnavailable) {
    return NextResponse.json(
      { error: "Event/alarm history is not available for this console." },
      { status: 502 }
    );
  }

  // Merge and sort newest-first
  const all = [...alarms, ...events].sort(
    (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
  );

  return NextResponse.json({ data: all, total: all.length, events_unavailable: eventsUnavailable });
}

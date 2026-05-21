import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/cosec/analytics
 *
 * Query params:
 *   type        = presence | heatmap | attendance | denials   (required)
 *   location_id = uuid                                         (optional filter)
 *   device_id   = uuid                                         (optional filter)
 *   from        = YYYY-MM-DD                                   (default: 30 days ago)
 *   to          = YYYY-MM-DD                                   (default: today)
 *   days        = number                                       (shorthand for from/to window)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const p = request.nextUrl.searchParams;
  const type       = p.get("type");
  const locationId = p.get("location_id");
  const deviceId   = p.get("device_id");
  const days       = parseInt(p.get("days") ?? "30", 10);

  const toDate   = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const from = p.get("from") ?? fromDate.toISOString().split("T")[0];
  const to   = p.get("to")   ?? toDate.toISOString().split("T")[0];

  // Resolve device ids for location filter
  let deviceIds: string[] = [];
  if (deviceId) {
    deviceIds = [deviceId];
  } else if (locationId) {
    const { data: devs } = await supabase
      .from("cosec_devices")
      .select("id")
      .eq("location_id", locationId)
      .eq("is_enabled", true);
    deviceIds = (devs ?? []).map(d => d.id);
    if (deviceIds.length === 0) return NextResponse.json({ data: [] });
  }

  switch (type) {
    case "presence":      return handlePresence(supabase, deviceIds, locationId);
    case "heatmap":       return handleHeatmap(supabase, deviceIds, from, to);
    case "attendance":    return handleAttendance(supabase, deviceIds, from, to);
    case "denials":       return handleDenials(supabase, deviceIds, from, to);
    default:
      return NextResponse.json({ error: "type must be one of: presence, heatmap, attendance, denials" }, { status: 400 });
  }
}

// ── Presence ─────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handlePresence(supabase: any, deviceIds: string[], locationId: string | null) {
  let query = supabase
    .from("cosec_presence")
    .select("*, device:cosec_devices(id, label, location_id, location:locations(id, name))");

  if (deviceIds.length > 0) query = query.in("device_id", deviceIds);

  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[];
  const present = rows.filter((r: { is_inside: boolean }) => r.is_inside);
  const total   = rows.length;
  const inside  = present.length;

  return NextResponse.json({
    data: rows,
    summary: { total, inside, outside: total - inside },
    locationId,
  });
}

// ── Heatmap ───────────────────────────────────────────────────────────────────
// Returns count of IN events grouped by hour-of-day × day-of-week (IST)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleHeatmap(supabase: any, deviceIds: string[], from: string, to: string) {
  let query = supabase
    .from("access_logs")
    .select("event_time, direction, device_id")
    .eq("direction", "IN")
    .gte("event_time", `${from}T00:00:00+05:30`)
    .lte("event_time", `${to}T23:59:59+05:30`);

  if (deviceIds.length > 0) query = query.in("device_id", deviceIds);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Build 7×24 grid in IST
  const grid: Record<string, number> = {};
  for (const row of data ?? []) {
    const ist = new Date(new Date(row.event_time).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hour = ist.getHours();
    const dow  = ist.getDay(); // 0=Sunday
    const key  = `${dow}_${hour}`;
    grid[key] = (grid[key] ?? 0) + 1;
  }

  // Flatten to array for recharts-friendly format
  const heatmap: { day: number; hour: number; count: number }[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      heatmap.push({ day, hour, count: grid[`${day}_${hour}`] ?? 0 });
    }
  }

  const maxCount = Math.max(...heatmap.map(h => h.count), 1);
  return NextResponse.json({ data: heatmap, maxCount, from, to });
}

// ── Attendance ────────────────────────────────────────────────────────────────
// Per-entity daily visit counts within the window
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAttendance(supabase: any, deviceIds: string[], from: string, to: string) {
  let query = supabase
    .from("access_logs")
    .select("entity_id, entity_name, user_type, direction, event_time, device_id")
    .eq("direction", "IN")
    .not("entity_id", "is", null)
    .gte("event_time", `${from}T00:00:00+05:30`)
    .lte("event_time", `${to}T23:59:59+05:30`);

  if (deviceIds.length > 0) query = query.in("device_id", deviceIds);

  const { data, error } = await query.order("event_time", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group by entity → array of visit dates
  const entityMap = new Map<string, {
    entity_id: string;
    entity_name: string;
    user_type: string;
    visit_dates: Set<string>;
    first_seen: string;
    last_seen: string;
    total_entries: number;
  }>();

  for (const row of data ?? []) {
    if (!row.entity_id) continue;
    const ist = new Date(new Date(row.event_time).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const dateStr = ist.toISOString().split("T")[0];

    if (!entityMap.has(row.entity_id)) {
      entityMap.set(row.entity_id, {
        entity_id: row.entity_id,
        entity_name: row.entity_name ?? `Ref #${row.entity_id.slice(0, 8)}`,
        user_type: row.user_type,
        visit_dates: new Set(),
        first_seen: row.event_time,
        last_seen: row.event_time,
        total_entries: 0,
      });
    }
    const entry = entityMap.get(row.entity_id)!;
    entry.visit_dates.add(dateStr);
    entry.last_seen = row.event_time;
    entry.total_entries++;
  }

  const attendance = Array.from(entityMap.values()).map(e => ({
    entity_id: e.entity_id,
    entity_name: e.entity_name,
    user_type: e.user_type,
    unique_days: e.visit_dates.size,
    total_entries: e.total_entries,
    first_seen: e.first_seen,
    last_seen: e.last_seen,
    visit_dates: Array.from(e.visit_dates).sort(),
  }));

  // Sort by most frequent first
  attendance.sort((a, b) => b.unique_days - a.unique_days);

  return NextResponse.json({ data: attendance, from, to });
}

// ── Denials ───────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleDenials(supabase: any, deviceIds: string[], from: string, to: string) {
  let query = supabase
    .from("access_logs")
    .select("entity_id, entity_name, user_type, denial_reason, event_time, device_id, device:cosec_devices(label)")
    .eq("direction", "DENIED")
    .gte("event_time", `${from}T00:00:00+05:30`)
    .lte("event_time", `${to}T23:59:59+05:30`);

  if (deviceIds.length > 0) query = query.in("device_id", deviceIds);

  const { data, error } = await query.order("event_time", { ascending: false }).limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group by entity for summary
  const entityDenials = new Map<string, {
    entity_id: string | null;
    entity_name: string;
    user_type: string | null;
    count: number;
    reasons: Record<string, number>;
    last_denied_at: string;
  }>();

  for (const row of data ?? []) {
    const key = row.entity_id ?? `unknown_${row.denial_reason}`;
    if (!entityDenials.has(key)) {
      entityDenials.set(key, {
        entity_id: row.entity_id,
        entity_name: row.entity_name ?? "Unknown",
        user_type: row.user_type,
        count: 0,
        reasons: {},
        last_denied_at: row.event_time,
      });
    }
    const entry = entityDenials.get(key)!;
    entry.count++;
    const reason = row.denial_reason ?? "Unknown";
    entry.reasons[reason] = (entry.reasons[reason] ?? 0) + 1;
  }

  const denialSummary = Array.from(entityDenials.values()).sort((a, b) => b.count - a.count);

  return NextResponse.json({
    data: data ?? [],           // raw events
    summary: denialSummary,     // grouped by entity
    total: (data ?? []).length,
    from,
    to,
  });
}

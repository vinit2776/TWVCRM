import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/public/occupancy
 *
 * Public endpoint — no auth required.
 * Returns aggregate occupancy counts only (no names or PII).
 * Designed for lobby display screens and member-facing widgets.
 *
 * Query params:
 *   location_id = uuid   (optional — filter to one location)
 */
export async function GET(request: NextRequest) {
  const admin = createAdminClient();
  const locationId = request.nextUrl.searchParams.get("location_id");

  // Fetch all locations with capacity config
  const locBaseQuery = admin
    .from("locations")
    .select("id, name, capacity_config")
    .order("name");
  const { data: locations } = await (locationId ? locBaseQuery.eq("id", locationId) : locBaseQuery);

  // Fetch everyone currently inside
  const { data: presence } = await admin
    .from("cosec_presence")
    .select("entity_id, user_type, device:cosec_devices(location_id)")
    .eq("is_inside", true);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (presence ?? []) as unknown as Array<{
    entity_id: string;
    user_type: string;
    device: { location_id: string } | null;
  }>;

  // Filter by location if requested
  const filtered = locationId
    ? rows.filter(r => r.device?.location_id === locationId)
    : rows;

  // Build per-location counts
  const locMap = new Map<string, { name: string; capacity: number; inside: number; by_type: Record<string, number> }>();

  for (const loc of locations ?? []) {
    const cfg = (loc.capacity_config ?? {}) as Record<string, number>;
    const capacity = Object.values(cfg).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
    locMap.set(loc.id, { name: loc.name, capacity, inside: 0, by_type: {} });
  }

  for (const row of filtered) {
    const locId = row.device?.location_id;
    if (!locId) continue;
    const entry = locMap.get(locId);
    if (!entry) continue;
    entry.inside++;
    entry.by_type[row.user_type] = (entry.by_type[row.user_type] ?? 0) + 1;
  }

  // Global type breakdown (all locations)
  const globalByType: Record<string, number> = {};
  for (const row of filtered) {
    globalByType[row.user_type] = (globalByType[row.user_type] ?? 0) + 1;
  }

  const locationData = [...locMap.values()].map(l => ({
    name: l.name,
    inside: l.inside,
    capacity: l.capacity,
    pct: l.capacity > 0 ? Math.round((l.inside / l.capacity) * 100) : null,
    by_type: l.by_type,
  }));

  return NextResponse.json({
    total_inside: filtered.length,
    total_capacity: locationData.reduce((s, l) => s + l.capacity, 0),
    by_type: globalByType,
    locations: locationData,
    updated_at: new Date().toISOString(),
  }, {
    headers: {
      // Allow embedding in lobby kiosk iframes, cache for 20 seconds
      "Cache-Control": "public, max-age=20, stale-while-revalidate=10",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

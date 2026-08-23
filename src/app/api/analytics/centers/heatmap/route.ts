/**
 * GET /api/analytics/centers/heatmap?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Per-space-unit occupancy (percent of days in range with a live-contract
 * allocation) and current revenue (this unit's tenant's monthly-equivalent
 * rate, capacity-apportioned across any other units the same contract
 * holds today) — backs the Space Heat Map section. Admin only.
 *
 * Returns every active unit across every location in one call — the page
 * groups by center for its tabs and computes the "most occupied" / "highest
 * revenue" spotlights across all of them, same shape as summary/trend.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  parseDateRange,
  todayIstDate,
  fetchSpaceUnitsDetailed,
  fetchSpaceAllocationsForHeatmap,
  computeUnitHeatmapStats,
} from "@/lib/analytics/center-metrics";

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return { error: "Admin access required", status: 403 as const };
  }
  return { error: null, status: 200 as const };
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let range;
  try {
    range = parseDateRange(request.nextUrl.searchParams);
  } catch (message) {
    return NextResponse.json({ error: String(message) }, { status: 400 });
  }

  const { data: locations, error: locErr } = await supabase
    .from("locations").select("id, name").eq("is_active", true);
  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });
  const locationNameById = new Map((locations ?? []).map((l) => [l.id as string, l.name as string]));

  let units, allocations;
  try {
    [units, allocations] = await Promise.all([
      fetchSpaceUnitsDetailed(supabase),
      fetchSpaceAllocationsForHeatmap(supabase),
    ]);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const stats = computeUnitHeatmapStats(units, allocations, range, todayIstDate());
  const result = stats.map((s) => ({
    ...s,
    location_name: locationNameById.get(s.location_id) ?? "Unknown",
  }));

  return NextResponse.json({ data: { range, units: result } });
}

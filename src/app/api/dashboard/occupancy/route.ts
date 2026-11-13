import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getDashboardAuth } from "@/lib/dashboard-auth";

/**
 * GET /api/dashboard/occupancy?location_id=<uuid>
 * Returns seat occupancy by location: total seats (sum of capacity across
 * active space_units), occupied seats (count of active space_seat_occupants),
 * vacant seats, and percentage. When no location filter, groups per location.
 *
 * Access: admin, manager.
 */
export async function GET(request: NextRequest) {
  const { user, dbUser } = await getDashboardAuth();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");

  let unitsQ = adminSupabase
    .from("space_units")
    .select("id, location_id, capacity, is_active, type")
    .eq("is_active", true);

  let occQ = adminSupabase
    .from("space_seat_occupants")
    .select("id, location_id, status")
    .eq("status", "active");

  let locsQ = adminSupabase
    .from("locations")
    .select("id, name");

  if (locationId) {
    unitsQ = unitsQ.eq("location_id", locationId);
    occQ = occQ.eq("location_id", locationId);
    locsQ = locsQ.eq("id", locationId);
  }

  const [
    { data: units },
    { data: occupants },
    { data: locations },
  ] = await Promise.all([unitsQ, occQ, locsQ]);

  const locById = new Map<string, string>();
  for (const l of locations ?? []) locById.set(l.id as string, l.name as string);

  const capByLoc: Record<string, number> = {};
  for (const u of units ?? []) {
    // Skip business_centre / hourly-only types — they're not "seats" in occupancy terms
    if (u.type === "business_centre") continue;
    const lid = u.location_id as string;
    capByLoc[lid] = (capByLoc[lid] ?? 0) + Number(u.capacity ?? 0);
  }

  const occByLoc: Record<string, number> = {};
  for (const o of occupants ?? []) {
    const lid = o.location_id as string;
    occByLoc[lid] = (occByLoc[lid] ?? 0) + 1;
  }

  const allLocIds = Array.from(new Set([...Object.keys(capByLoc), ...Object.keys(occByLoc)]));
  const rows = allLocIds.map((id) => {
    const cap = capByLoc[id] ?? 0;
    const occ = Math.min(occByLoc[id] ?? 0, cap);
    const vacant = Math.max(cap - occ, 0);
    const pct = cap > 0 ? Math.round((occ / cap) * 100) : 0;
    return {
      location_id: id,
      location_name: locById.get(id) ?? "Unknown",
      capacity: cap,
      occupied: occ,
      vacant,
      occupancy_pct: pct,
    };
  });

  rows.sort((a, b) => b.occupancy_pct - a.occupancy_pct);

  const totalCap = rows.reduce((s, r) => s + r.capacity, 0);
  const totalOcc = rows.reduce((s, r) => s + r.occupied, 0);

  return NextResponse.json({
    data: {
      total_capacity: totalCap,
      total_occupied: totalOcc,
      total_vacant: Math.max(totalCap - totalOcc, 0),
      overall_pct: totalCap > 0 ? Math.round((totalOcc / totalCap) * 100) : 0,
      locations: rows,
    },
  });
}

/**
 * GET /api/analytics/centers/summary?start=YYYY-MM-DD&end=YYYY-MM-DD&location_id=<uuid>
 *
 * Per-center sales/collections/billed/occupancy for one date range — backs
 * the Center Analytics KPI tiles and comparison table. Admin only.
 *
 * See docs/plans/center-analytics-data-source.md for what each metric means
 * and why: Sales/Collections/Billed are bucketed by when the underlying
 * record belongs to the range (contract activation, billing period_start),
 * not by when cash moved; Occupancy is a snapshot as of `end` (clamped to
 * today), not a range aggregate.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  parseDateRange,
  todayIstDate,
  istDayBounds,
  fetchContracts,
  fetchStatements,
  fetchPaymentsTotal,
  fetchActiveSpaceUnits,
  fetchSpaceAllocations,
  computeOccupancyByLocation,
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
  const locationId = request.nextUrl.searchParams.get("location_id") || undefined;

  let locsQ = supabase.from("locations").select("id, name, is_active");
  locsQ = locationId ? locsQ.eq("id", locationId) : locsQ.eq("is_active", true);
  const { data: locations, error: locErr } = await locsQ;
  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });

  let contracts, statements, units, allocations;
  try {
    [contracts, statements, units, allocations] = await Promise.all([
      fetchContracts(supabase, locationId),
      fetchStatements(supabase, range),
      fetchActiveSpaceUnits(supabase, locationId),
      fetchSpaceAllocations(supabase, locationId),
    ]);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const contractLocationById = new Map(contracts.map((c) => [c.id, c.location_id]));

  const asOfDate = range.end > todayIstDate() ? todayIstDate() : range.end;
  const occByLocation = computeOccupancyByLocation(units, allocations, asOfDate);

  const { startIso: salesStartIso } = istDayBounds(range.start);
  const { endIso: salesEndIso } = istDayBounds(range.end);
  const salesByLocation = new Map<string, number>();
  for (const c of contracts) {
    if (!c.activated_at) continue;
    if (c.activated_at < salesStartIso || c.activated_at > salesEndIso) continue;
    salesByLocation.set(c.location_id, (salesByLocation.get(c.location_id) ?? 0) + Number(c.total_amount || 0));
  }

  const billedByLocation = new Map<string, number>();
  const statementIdsByLocation = new Map<string, string[]>();
  for (const s of statements) {
    const locId = contractLocationById.get(s.contract_id);
    if (!locId) continue; // orphaned/deleted contract — skip rather than misattribute
    billedByLocation.set(locId, (billedByLocation.get(locId) ?? 0) + Number(s.total_amount || 0));
    if (!statementIdsByLocation.has(locId)) statementIdsByLocation.set(locId, []);
    statementIdsByLocation.get(locId)!.push(s.id);
  }

  const allStatementIds = statements.map((s) => s.id);
  const paidByStatement = await fetchPaymentsTotal(supabase, allStatementIds);
  const collectionsByLocation = new Map<string, number>();
  for (const s of statements) {
    const locId = contractLocationById.get(s.contract_id);
    if (!locId) continue;
    const paid = paidByStatement.get(s.id) ?? 0;
    collectionsByLocation.set(locId, (collectionsByLocation.get(locId) ?? 0) + paid);
  }

  const centers = (locations ?? []).map((loc) => {
    const locId = loc.id as string;
    const sales = salesByLocation.get(locId) ?? 0;
    const billed = billedByLocation.get(locId) ?? 0;
    const collections = collectionsByLocation.get(locId) ?? 0;
    const occ = occByLocation.get(locId) ?? { capacity: 0, occupied: 0 };
    return {
      location_id: locId,
      location_name: loc.name as string,
      sales: Math.round(sales),
      billed: Math.round(billed),
      collections: Math.round(collections),
      collection_efficiency_pct: billed > 0 ? Math.round((collections / billed) * 100) : 0,
      occupied_seats: occ.occupied,
      capacity: occ.capacity,
      occupancy_pct: occ.capacity > 0 ? Math.round((occ.occupied / occ.capacity) * 100) : 0,
    };
  });

  return NextResponse.json({
    data: {
      range,
      as_of: asOfDate,
      centers,
    },
  });
}

/**
 * GET /api/analytics/centers/trend?metric=sales|collections|occ&months=6&location_id=<uuid>
 *
 * Per-center monthly series for one metric — backs the Center Analytics
 * trend chart's metric tabs (one call per tab, matching the mockup's
 * behavior). Admin only. See center-metrics.ts for the cohort-vs-snapshot
 * distinction between sales/collections and occupancy.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  trailingMonthWindows,
  fetchContracts,
  fetchStatements,
  fetchPaymentsTotal,
  fetchActiveSpaceUnits,
  fetchSpaceAllocations,
  computeOccupancyByLocation,
  sumSalesInRange,
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

const querySchema = z.object({
  metric: z.enum(["sales", "collections", "occ"]),
  months: z.coerce.number().int().min(1).max(12).default(6),
  location_id: z.string().uuid().optional(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = querySchema.safeParse({
    metric: request.nextUrl.searchParams.get("metric"),
    months: request.nextUrl.searchParams.get("months") ?? undefined,
    location_id: request.nextUrl.searchParams.get("location_id") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }
  const { metric, months, location_id: locationId } = parsed.data;

  let locsQ = supabase.from("locations").select("id, name, is_active");
  locsQ = locationId ? locsQ.eq("id", locationId) : locsQ.eq("is_active", true);
  const { data: locations, error: locErr } = await locsQ;
  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });

  const windows = trailingMonthWindows(months);
  const pointsByLocation = new Map<string, Array<{ month: string; value: number }>>();
  for (const loc of locations ?? []) pointsByLocation.set(loc.id as string, []);

  try {
    if (metric === "sales") {
      const contracts = await fetchContracts(supabase, locationId);
      for (const w of windows) {
        for (const loc of locations ?? []) {
          const value = sumSalesInRange(contracts, w, loc.id as string);
          pointsByLocation.get(loc.id as string)!.push({ month: w.key, value: Math.round(value) });
        }
      }
    } else if (metric === "collections") {
      const contracts = await fetchContracts(supabase, locationId);
      const contractLocationById = new Map(contracts.map((c) => [c.id, c.location_id]));
      const fullSpan = { start: windows[0].start, end: windows[windows.length - 1].end };
      const statements = await fetchStatements(supabase, fullSpan);
      const relevantStatements = locationId
        ? statements.filter((s) => contractLocationById.get(s.contract_id) === locationId)
        : statements;
      const paidByStatement = await fetchPaymentsTotal(supabase, relevantStatements.map((s) => s.id));

      for (const w of windows) {
        const collectionsByLocation = new Map<string, number>();
        for (const s of relevantStatements) {
          if (s.period_start < w.start || s.period_start > w.end) continue;
          const locId = contractLocationById.get(s.contract_id);
          if (!locId) continue;
          const paid = paidByStatement.get(s.id) ?? 0;
          collectionsByLocation.set(locId, (collectionsByLocation.get(locId) ?? 0) + paid);
        }
        for (const loc of locations ?? []) {
          const value = collectionsByLocation.get(loc.id as string) ?? 0;
          pointsByLocation.get(loc.id as string)!.push({ month: w.key, value: Math.round(value) });
        }
      }
    } else {
      const units = await fetchActiveSpaceUnits(supabase, locationId);
      const allocations = await fetchSpaceAllocations(supabase, locationId);
      for (const w of windows) {
        const occByLocation = computeOccupancyByLocation(units, allocations, w.end);
        for (const loc of locations ?? []) {
          const occ = occByLocation.get(loc.id as string) ?? { capacity: 0, occupied: 0 };
          const pct = occ.capacity > 0 ? Math.round((occ.occupied / occ.capacity) * 100) : 0;
          pointsByLocation.get(loc.id as string)!.push({ month: w.key, value: pct });
        }
      }
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const centers = (locations ?? []).map((loc) => ({
    location_id: loc.id as string,
    location_name: loc.name as string,
    points: pointsByLocation.get(loc.id as string) ?? [],
  }));

  return NextResponse.json({ data: { metric, months, centers } });
}

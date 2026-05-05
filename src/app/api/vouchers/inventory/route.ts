import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { VOUCHER_LOW_STOCK_THRESHOLD } from "@/lib/constants";
import { getValidityLabel } from "@/lib/utils";
import type { VoucherStockLevel } from "@/types";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const locationId = request.nextUrl.searchParams.get("location_id");

  // Fetch ALL vouchers in pages of 1000 (Supabase default limit is 1000).
  // Now also pulls location_id so we can group by (location, validity) — each
  // location runs its own physical voucher pool, so showing a single mixed
  // "1 day · 47 available" card across all locations was misleading.
  const PAGE_SIZE = 1000;
  type VoucherRow = { validity_days: number | null; status: string; location_id: string | null };
  let allVouchers: VoucherRow[] = [];
  let offset = 0;
  let fetchError: { message: string } | null = null;

  while (true) {
    let query = supabase
      .from("voucher_repository")
      .select("validity_days, status, location_id")
      .range(offset, offset + PAGE_SIZE - 1);
    if (locationId) query = query.eq("location_id", locationId);

    const { data, error } = await query;

    if (error) {
      fetchError = error;
      break;
    }

    if (data && data.length > 0) {
      allVouchers = allVouchers.concat(data as VoucherRow[]);
      offset += data.length;
      if (data.length < PAGE_SIZE) break;
    } else {
      break;
    }
  }

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  // One round-trip to resolve location names for the IDs we found
  const locIds = Array.from(
    new Set(allVouchers.map((v) => v.location_id).filter(Boolean) as string[])
  );
  let locMap = new Map<string, { id: string; name: string; code: string }>();
  if (locIds.length > 0) {
    const { data: locs } = await supabase
      .from("locations")
      .select("id, name, code")
      .in("id", locIds);
    locMap = new Map((locs ?? []).map((l) => [l.id as string, l]));
  }

  const groups = buildInventory(allVouchers, locMap);
  return NextResponse.json(groups);
}

function getStockLevel(available: number): VoucherStockLevel {
  if (available === 0) return "red";
  if (available < VOUCHER_LOW_STOCK_THRESHOLD) return "amber";
  return "green";
}

function buildInventory(
  rows: Array<{ validity_days: number | null; status: string; location_id: string | null }>,
  locMap: Map<string, { id: string; name: string; code: string }>,
) {
  // Compound key: <location_id|null>::<validity|null>. Each location runs
  // its own pool, so vouchers must be grouped per-location-per-validity.
  type Group = {
    validity_days: number | null;
    location_id: string | null;
    location_name: string | null;
    location_code: string | null;
    available: number;
    issued: number;
    total: number;
  };
  const groupMap = new Map<string, Group>();

  for (const row of rows) {
    const locKey = row.location_id ?? "null";
    const valKey = row.validity_days == null ? "null" : String(row.validity_days);
    const key = `${locKey}::${valKey}`;
    if (!groupMap.has(key)) {
      const loc = row.location_id ? locMap.get(row.location_id) : null;
      groupMap.set(key, {
        validity_days: row.validity_days,
        location_id: row.location_id,
        location_name: loc?.name ?? null,
        location_code: loc?.code ?? null,
        available: 0,
        issued: 0,
        total: 0,
      });
    }
    const g = groupMap.get(key)!;
    g.total += 1;
    if (row.status === "available") g.available += 1;
    else if (row.status === "issued") g.issued += 1;
  }

  const data = Array.from(groupMap.values())
    .map((g) => ({
      ...g,
      label: getValidityLabel(g.validity_days),
      stock_level: getStockLevel(g.available),
    }))
    .sort((a, b) => {
      // Group by location name first (so cards for the same location sit
      // together), then by validity ascending. NULL location and NULL
      // validity sink to the end.
      const locA = a.location_name ?? "￿";
      const locB = b.location_name ?? "￿";
      if (locA !== locB) return locA.localeCompare(locB);
      if (a.validity_days === null) return 1;
      if (b.validity_days === null) return -1;
      return a.validity_days - b.validity_days;
    });

  const lowStockAlerts = data.filter(
    (g) => g.stock_level === "red" || g.stock_level === "amber"
  );

  return {
    data,
    low_stock_alerts: lowStockAlerts,
    // First Unclassified group encountered is enough for the alert banner.
    // Existing callers only check for presence, not exact match.
    unclassified: data.find((g) => g.validity_days === null) || null,
  };
}

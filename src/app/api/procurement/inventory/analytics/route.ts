import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { STOCK_DEPARTMENTS } from "@/lib/constants";

/**
 * GET /api/procurement/inventory/analytics?location_id=X&from=ISO&to=ISO
 *
 * Per-location stock-holding + consumption analytics for a manager snapshot.
 * Holding is computed from current stock; consumption from logs in [from, to].
 * Only physical-stock goods (STOCK_DEPARTMENTS, non-service) are counted.
 */

const REORDER_HORIZON_DAYS = 14; // flag a stockout if cover is under this

interface StockRow {
  quantity_on_hand: number | string;
  reorder_level: number | string;
  item_id: string;
  procurement_items: {
    name: string;
    department: string;
    item_type: string | null;
    unit: string | null;
    standard_price: number | string | null;
  } | null;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  if (!locationId) return NextResponse.json({ error: "location_id required" }, { status: 400 });

  // Period — default last 30 days
  const toParam = searchParams.get("to");
  const fromParam = searchParams.get("from");
  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam ? new Date(fromParam) : new Date(to.getTime() - 30 * 86400000);
  const periodDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));

  // ── Current holding ────────────────────────────────────────────────────
  const { data: stockRaw } = await supabase
    .from("location_stock")
    .select(
      "quantity_on_hand, reorder_level, item_id, procurement_items(name, department, item_type, unit, standard_price)"
    )
    .eq("location_id", locationId);

  const stock = ((stockRaw ?? []) as unknown as StockRow[]).filter((r) => {
    const pi = r.procurement_items;
    return pi && STOCK_DEPARTMENTS.includes(pi.department) && pi.item_type !== "service";
  });

  const num = (v: unknown) => Number(v) || 0;
  const priceOf = (r: StockRow) => {
    const p = r.procurement_items?.standard_price;
    return p == null ? null : Number(p);
  };

  let totalUnits = 0;
  let totalValue = 0;
  let unpricedCount = 0;
  const statusCounts = { ok: 0, low: 0, out: 0 };
  const byDept: Record<string, { items: number; units: number; value: number }> = {};
  const belowReorder: { name: string; qty: number; reorder_level: number; unit: string; department: string }[] = [];

  for (const r of stock) {
    const qty = num(r.quantity_on_hand);
    const reorder = num(r.reorder_level);
    const price = priceOf(r);
    const value = price == null ? 0 : price * qty;
    if (price == null) unpricedCount++;

    totalUnits += qty;
    totalValue += value;

    const status = qty === 0 ? "out" : reorder > 0 && qty <= reorder ? "low" : "ok";
    statusCounts[status]++;

    const dept = r.procurement_items?.department ?? "other";
    byDept[dept] = byDept[dept] || { items: 0, units: 0, value: 0 };
    byDept[dept].items++;
    byDept[dept].units += qty;
    byDept[dept].value += value;

    if (status !== "ok" || (reorder > 0 && qty <= reorder)) {
      if (qty === 0 || (reorder > 0 && qty <= reorder)) {
        belowReorder.push({
          name: r.procurement_items?.name ?? "—",
          qty,
          reorder_level: reorder,
          unit: r.procurement_items?.unit ?? "",
          department: dept,
        });
      }
    }
  }

  const topByValue = stock
    .map((r) => {
      const qty = num(r.quantity_on_hand);
      const price = priceOf(r);
      return {
        name: r.procurement_items?.name ?? "—",
        department: r.procurement_items?.department ?? "",
        qty,
        unit: r.procurement_items?.unit ?? "",
        value: price == null ? 0 : price * qty,
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // ── Consumption in period ──────────────────────────────────────────────
  const { data: logsRaw } = await supabase
    .from("consumption_logs")
    .select("id, logged_at, status, consumption_log_items(item_id, item_name, unit, quantity_consumed)")
    .eq("location_id", locationId)
    .eq("status", "active")
    .gte("logged_at", from.toISOString())
    .lte("logged_at", to.toISOString());

  const logs = (logsRaw ?? []) as unknown as {
    id: string;
    logged_at: string;
    consumption_log_items: { item_id: string | null; item_name: string; unit: string | null; quantity_consumed: number | string }[];
  }[];

  // price lookup by item_id (from stock rows + a fallback fetch for items not in stock)
  const priceByItem = new Map<string, number | null>();
  const deptByItem = new Map<string, string>();
  for (const r of stock) {
    priceByItem.set(r.item_id, priceOf(r));
    if (r.procurement_items?.department) deptByItem.set(r.item_id, r.procurement_items.department);
  }

  let consUnits = 0;
  let consValue = 0;
  const consByItem: Record<string, { name: string; unit: string; units: number; value: number }> = {};
  const consByDept: Record<string, { units: number; value: number }> = {};
  const consumedItemIds = new Set<string>();
  const bucketByWeek = periodDays > 31;
  const trendMap: Record<string, { units: number; value: number }> = {};

  for (const log of logs) {
    const d = new Date(log.logged_at);
    const bucketKey = bucketByWeek
      ? new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10) // week start (Mon)
      : d.toISOString().slice(0, 10);
    for (const it of log.consumption_log_items ?? []) {
      const qty = num(it.quantity_consumed);
      const price = it.item_id ? priceByItem.get(it.item_id) ?? null : null;
      const value = price == null ? 0 : price * qty;
      consUnits += qty;
      consValue += value;
      if (it.item_id) consumedItemIds.add(it.item_id);

      const key = it.item_name;
      consByItem[key] = consByItem[key] || { name: it.item_name, unit: it.unit ?? "", units: 0, value: 0 };
      consByItem[key].units += qty;
      consByItem[key].value += value;

      const dept = it.item_id ? deptByItem.get(it.item_id) ?? "other" : "other";
      consByDept[dept] = consByDept[dept] || { units: 0, value: 0 };
      consByDept[dept].units += qty;
      consByDept[dept].value += value;

      trendMap[bucketKey] = trendMap[bucketKey] || { units: 0, value: 0 };
      trendMap[bucketKey].units += qty;
      trendMap[bucketKey].value += value;
    }
  }

  const topConsumed = Object.values(consByItem).sort((a, b) => b.units - a.units).slice(0, 8);
  const trend = Object.entries(trendMap)
    .map(([date, v]) => ({ date, units: v.units, value: v.value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // ── Predicted stockouts & dead stock (need consumption history) ─────────
  const consQtyByItem = new Map<string, number>();
  for (const log of logs) {
    for (const it of log.consumption_log_items ?? []) {
      if (it.item_id) consQtyByItem.set(it.item_id, (consQtyByItem.get(it.item_id) ?? 0) + num(it.quantity_consumed));
    }
  }

  const predictedStockouts = stock
    .map((r) => {
      const qty = num(r.quantity_on_hand);
      const consumed = consQtyByItem.get(r.item_id) ?? 0;
      const avgDaily = consumed / periodDays;
      const daysOfCover = avgDaily > 0 ? qty / avgDaily : Infinity;
      return {
        name: r.procurement_items?.name ?? "—",
        qty,
        unit: r.procurement_items?.unit ?? "",
        avgDaily: Math.round(avgDaily * 100) / 100,
        daysOfCover: Number.isFinite(daysOfCover) ? Math.round(daysOfCover) : null,
      };
    })
    .filter((x) => x.daysOfCover != null && x.daysOfCover <= REORDER_HORIZON_DAYS)
    .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0))
    .slice(0, 10);

  const hasConsumption = logs.length > 0;
  const deadStock = hasConsumption
    ? stock
        .filter((r) => num(r.quantity_on_hand) > 0 && !consumedItemIds.has(r.item_id))
        .map((r) => {
          const qty = num(r.quantity_on_hand);
          const price = priceOf(r);
          return {
            name: r.procurement_items?.name ?? "—",
            department: r.procurement_items?.department ?? "",
            qty,
            unit: r.procurement_items?.unit ?? "",
            value: price == null ? 0 : price * qty,
          };
        })
        .sort((a, b) => b.value - a.value)
        .slice(0, 10)
    : [];

  // avg days of cover across items that have movement
  const coverVals = stock
    .map((r) => {
      const consumed = consQtyByItem.get(r.item_id) ?? 0;
      const avgDaily = consumed / periodDays;
      return avgDaily > 0 ? num(r.quantity_on_hand) / avgDaily : null;
    })
    .filter((v): v is number => v != null && Number.isFinite(v));
  const avgDaysOfCover = coverVals.length
    ? Math.round(coverVals.reduce((a, b) => a + b, 0) / coverVals.length)
    : null;

  return NextResponse.json({
    period: { from: from.toISOString(), to: to.toISOString(), days: periodDays, bucket: bucketByWeek ? "week" : "day" },
    holding: {
      itemCount: stock.length,
      totalUnits,
      totalValue,
      unpricedCount,
      status: statusCounts,
      byDepartment: Object.entries(byDept).map(([department, v]) => ({ department, ...v })),
      topByValue,
    },
    needsAttention: {
      belowReorder: belowReorder.sort((a, b) => a.qty - b.qty),
      predictedStockouts,
      deadStock,
      hasConsumption,
    },
    consumption: {
      logCount: logs.length,
      totalUnits: consUnits,
      totalValue: consValue,
      avgDaysOfCover,
      trend,
      topItems: topConsumed,
      byDepartment: Object.entries(consByDept).map(([department, v]) => ({ department, ...v })),
      hasData: hasConsumption,
    },
  });
}

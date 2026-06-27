import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { STOCK_DEPARTMENTS } from "@/lib/constants";

/**
 * GET /api/procurement/replenishment
 *
 * Two-tier MOQ replenishment, SUGGESTION-ONLY (no writes):
 *  - For every non-hub location item where on_hand <= reorder_level (min) and
 *    max_level is set, suggest a refill transfer from HQ of (max - on_hand).
 *  - Cross-check each item's total suggested qty against HQ (hub) on-hand and
 *    flag whether HQ can actually cover it ("HQ short by N").
 *  - Also report HQ's own breaches (hub items at/below their min) so HQ itself
 *    can be restocked (via MR -> PO -> Receipt).
 *
 * Only physical-stock goods (STOCK_DEPARTMENTS, non-service) are considered.
 */

interface StockRow {
  location_id: string;
  item_id: string;
  quantity_on_hand: number | string;
  reorder_level: number | string;
  max_level: number | string | null;
  procurement_items: {
    name: string;
    department: string;
    unit: string | null;
    item_type: string | null;
    default_reorder_level: number | string | null;
    default_max_level: number | string | null;
  } | null;
}

// Effective Min/Max = the location's own value, falling back to the catalog
// default when the location hasn't set one. reorder_level is NOT NULL (0 = unset).
const effMin = (r: StockRow) => {
  const own = num(r.reorder_level);
  if (own > 0) return own;
  const def = r.procurement_items?.default_reorder_level;
  return def == null ? 0 : Number(def);
};
const effMax = (r: StockRow): number | null => {
  if (r.max_level != null) return num(r.max_level);
  const def = r.procurement_items?.default_max_level;
  return def == null ? null : Number(def);
};

const num = (v: unknown) => Number(v) || 0;

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve the central hub.
  const { data: hub } = await supabase
    .from("locations")
    .select("id, name")
    .eq("is_hub", true)
    .limit(1)
    .maybeSingle();

  // All stock with the joined item (one query; split hub vs locations in JS).
  const { data: stockRaw, error } = await supabase
    .from("location_stock")
    .select(
      "location_id, item_id, quantity_on_hand, reorder_level, max_level, procurement_items(name, department, unit, item_type, default_reorder_level, default_max_level), locations(name, is_hub)"
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = ((stockRaw ?? []) as unknown as (StockRow & {
    locations: { name: string; is_hub: boolean } | null;
  })[]).filter((r) => {
    const pi = r.procurement_items;
    return pi && STOCK_DEPARTMENTS.includes(pi.department) && pi.item_type !== "service";
  });

  // Hub on-hand per item.
  const hubQtyByItem = new Map<string, number>();
  const hubRows = hub ? rows.filter((r) => r.location_id === hub.id) : [];
  for (const r of hubRows) hubQtyByItem.set(r.item_id, num(r.quantity_on_hand));

  // Location breaches -> raw suggestions.
  type Suggestion = {
    location_id: string;
    location_name: string;
    item_id: string;
    item_name: string;
    department: string;
    unit: string;
    on_hand: number;
    min: number;
    max: number;
    suggest_qty: number;
    hub_available: number;
    fulfillable: boolean;
    short_by: number;
  };

  const raw = rows.filter((r) => {
    if (hub && r.location_id === hub.id) return false; // skip the hub itself
    if (r.locations?.is_hub) return false;
    const max = effMax(r);
    if (max == null) return false; // auto-refill disabled (no Max anywhere)
    const onHand = num(r.quantity_on_hand);
    return onHand <= effMin(r) && max > onHand;
  });

  // Total suggested qty per item (across all breaching locations) for the HQ check.
  const neededByItem = new Map<string, number>();
  for (const r of raw) {
    const qty = (effMax(r) ?? 0) - num(r.quantity_on_hand);
    neededByItem.set(r.item_id, (neededByItem.get(r.item_id) ?? 0) + qty);
  }

  const suggestions: Suggestion[] = raw
    .map((r) => {
      const onHand = num(r.quantity_on_hand);
      const max = effMax(r) ?? 0;
      const suggestQty = max - onHand;
      const hubAvail = hubQtyByItem.get(r.item_id) ?? 0;
      const totalNeeded = neededByItem.get(r.item_id) ?? 0;
      const itemShort = Math.max(0, totalNeeded - hubAvail);
      return {
        location_id: r.location_id,
        location_name: r.locations?.name ?? "—",
        item_id: r.item_id,
        item_name: r.procurement_items?.name ?? "—",
        department: r.procurement_items?.department ?? "",
        unit: r.procurement_items?.unit ?? "",
        on_hand: onHand,
        min: effMin(r),
        max,
        suggest_qty: suggestQty,
        hub_available: hubAvail,
        fulfillable: hubAvail >= totalNeeded,
        short_by: itemShort,
      };
    })
    .sort((a, b) => a.location_name.localeCompare(b.location_name) || a.item_name.localeCompare(b.item_name));

  // HQ's own low stock (hub items at/below their min) — informational.
  const hubLowStock = hubRows
    .filter((r) => {
      const onHand = num(r.quantity_on_hand);
      const min = num(r.reorder_level);
      return min > 0 && onHand <= min;
    })
    .map((r) => ({
      item_id: r.item_id,
      item_name: r.procurement_items?.name ?? "—",
      department: r.procurement_items?.department ?? "",
      unit: r.procurement_items?.unit ?? "",
      on_hand: num(r.quantity_on_hand),
      min: num(r.reorder_level),
      max: r.max_level == null ? null : num(r.max_level),
    }))
    .sort((a, b) => a.on_hand - b.on_hand);

  const locationsAffected = new Set(suggestions.map((s) => s.location_id)).size;
  const totalSuggestedUnits = suggestions.reduce((acc, s) => acc + s.suggest_qty, 0);
  const shortItems = suggestions.filter((s) => !s.fulfillable).length;

  return NextResponse.json({
    hub: hub ? { id: hub.id, name: hub.name } : null,
    hubConfigured: !!hub,
    suggestions,
    hubLowStock,
    summary: {
      locationsAffected,
      itemsToRefill: suggestions.length,
      totalSuggestedUnits,
      shortItems,
      hubLowStockCount: hubLowStock.length,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const now = new Date();

  // Build 6-month windows
  const months: { label: string; start: string; end: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = d.toISOString();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString();
    const label = d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "2-digit" });
    months.push({ label, start, end });
  }

  const [
    itemRes,
    priceHistoryRes,
    vendorPricesRes,
    consumptionAllRes,
    poHistoryRes,
  ] = await Promise.all([
    // Item detail
    supabase
      .from("procurement_items")
      .select("*")
      .eq("id", id)
      .single(),

    // Price history (last 20)
    supabase
      .from("procurement_item_price_history")
      .select("id, old_price, new_price, changed_at, notes, changer:users!procurement_item_price_history_changed_by_fkey(id, full_name, email)")
      .eq("item_id", id)
      .order("changed_at", { ascending: false })
      .limit(20),

    // Vendor prices — all vendors who have priced this item
    supabase
      .from("vendor_item_prices")
      .select("id, vendor_id, price, gst_rate, last_po_number, last_po_id, updated_at, procurement_vendors(id, name)")
      .eq("item_id", id)
      .order("price", { ascending: true }),

    // All consumption log items for this item (for monthly breakdown)
    supabase
      .from("consumption_log_items")
      .select("quantity_consumed, consumption_logs(logged_at, location_id, locations(name))")
      .eq("item_id", id),

    // PO history: orders that included this item (last 20)
    supabase
      .from("purchase_order_items")
      .select("id, quantity_ordered, unit_price, total_amount, created_at, purchase_orders(id, po_number, status, created_at, procurement_vendors(id, name))")
      .eq("item_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (!itemRes.data) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  // ── Consumption: bucket by month ──────────────────────────────────────────
  type ConsumptionRow = {
    quantity_consumed: number;
    consumption_logs: { logged_at: string; location_id: string; locations: { name: string } | null } | null;
  };

  const allConsumption = (consumptionAllRes.data ?? []) as unknown as ConsumptionRow[];

  const consumptionByMonth = months.map(({ label, start, end }) => {
    const qty = allConsumption
      .filter((r) => {
        const loggedAt = r.consumption_logs?.logged_at;
        return loggedAt && loggedAt >= start && loggedAt < end;
      })
      .reduce((sum, r) => sum + Number(r.quantity_consumed), 0);
    return { label, qty };
  });

  const consumptionTotal = allConsumption.reduce((sum, r) => sum + Number(r.quantity_consumed), 0);
  const consumptionThisMonth = consumptionByMonth[5]?.qty ?? 0;
  const consumptionLastMonth = consumptionByMonth[4]?.qty ?? 0;
  const consumptionTrend: "up" | "down" | "stable" =
    consumptionThisMonth > consumptionLastMonth * 1.05 ? "up" :
    consumptionThisMonth < consumptionLastMonth * 0.95 ? "down" : "stable";

  // Top consuming locations (all time)
  const locationTotals: Record<string, { name: string; qty: number }> = {};
  for (const r of allConsumption) {
    const locId = r.consumption_logs?.location_id;
    if (!locId) continue;
    const locName = r.consumption_logs?.locations?.name ?? "Unknown";
    if (!locationTotals[locId]) locationTotals[locId] = { name: locName, qty: 0 };
    locationTotals[locId].qty += Number(r.quantity_consumed);
  }
  const topLocations = Object.values(locationTotals)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  // ── Price performance ─────────────────────────────────────────────────────
  type PoRow = {
    id: string;
    quantity_ordered: number;
    unit_price: number | null;
    total_amount: number | null;
    created_at: string;
    purchase_orders: {
      id: string; po_number: string; status: string; created_at: string;
      procurement_vendors: { id: string; name: string } | null;
    } | null;
  };

  const poHistory = (poHistoryRes.data ?? []) as unknown as PoRow[];

  // Average unit price across all POs
  const pricedPos = poHistory.filter((r) => r.unit_price != null && r.unit_price > 0);
  const avgPoPrice = pricedPos.length
    ? pricedPos.reduce((sum, r) => sum + Number(r.unit_price), 0) / pricedPos.length
    : null;

  // Min / max PO price
  const poPrices = pricedPos.map((r) => Number(r.unit_price));
  const minPoPrice = poPrices.length ? Math.min(...poPrices) : null;
  const maxPoPrice = poPrices.length ? Math.max(...poPrices) : null;

  // Price history trend: compare most recent vs oldest available
  const priceHistory = priceHistoryRes.data ?? [];
  const latestPrice = priceHistory[0]?.new_price ?? null;
  const oldestPrice = priceHistory.length > 1
    ? priceHistory[priceHistory.length - 1]?.old_price
    : null;
  const priceTrend: "up" | "down" | "stable" =
    latestPrice && oldestPrice
      ? latestPrice > oldestPrice ? "up" : latestPrice < oldestPrice ? "down" : "stable"
      : "stable";

  return NextResponse.json({
    data: {
      item: itemRes.data,
      // Consumption
      consumptionByMonth,
      consumptionTotal,
      consumptionThisMonth,
      consumptionLastMonth,
      consumptionTrend,
      topLocations,
      // Price performance
      priceHistory,
      vendorPrices: vendorPricesRes.data ?? [],
      avgPoPrice,
      minPoPrice,
      maxPoPrice,
      priceTrend,
      // PO history
      poHistory,
    },
  });
}

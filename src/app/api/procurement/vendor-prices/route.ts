import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/procurement/vendor-prices
 *
 * Query params (at least one required):
 *   vendor_id   – all items priced for a vendor (for vendor detail tab)
 *   item_id     – all vendor prices for one item (cheapest-first)
 *   item_ids    – comma-separated list of item_ids (bulk fetch for MR approval)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const vendorId  = searchParams.get("vendor_id");
  const itemId    = searchParams.get("item_id");
  const itemIds   = searchParams.get("item_ids")?.split(",").map((s) => s.trim()).filter(Boolean);

  // ── Vendor price list (all items for one vendor) ─────────────────────────
  if (vendorId) {
    const { data, error } = await supabase
      .from("vendor_item_prices")
      .select(`
        id, vendor_id, item_id, price, gst_rate,
        last_po_id, last_po_number, updated_at,
        procurement_items(id, name, unit, department, standard_price),
        updater:users!vendor_item_prices_updated_by_fkey(id, full_name)
      `)
      .eq("vendor_id", vendorId)
      .order("updated_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data ?? [] });
  }

  // ── Single item: all vendor prices, cheapest first ────────────────────────
  if (itemId) {
    const { data, error } = await supabase
      .from("vendor_item_prices")
      .select(`
        id, vendor_id, item_id, price, gst_rate,
        last_po_id, last_po_number, updated_at,
        procurement_vendors(id, name)
      `)
      .eq("item_id", itemId)
      .order("price", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data ?? [] });
  }

  // ── Bulk item fetch (MR approval page) ────────────────────────────────────
  if (itemIds && itemIds.length > 0) {
    const { data, error } = await supabase
      .from("vendor_item_prices")
      .select(`
        id, vendor_id, item_id, price, gst_rate,
        last_po_id, last_po_number, updated_at,
        procurement_vendors(id, name)
      `)
      .in("item_id", itemIds)
      .order("price", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data ?? [] });
  }

  return NextResponse.json({ error: "Provide vendor_id, item_id, or item_ids" }, { status: 400 });
}

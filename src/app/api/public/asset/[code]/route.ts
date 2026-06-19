import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("facility_assets")
    .select(`
      id, name, asset_code, status,
      location:locations(id, name),
      floor:location_floors(id, name),
      category:facility_asset_categories(id, name, scope)
    `)
    .eq("asset_code", code)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  // Supabase FK joins may return arrays; unwrap to single object
  const loc = Array.isArray(data.location) ? data.location[0] : data.location;
  const flr = Array.isArray(data.floor) ? data.floor[0] : data.floor;
  const cat = Array.isArray(data.category) ? data.category[0] : data.category;

  // Check if this asset has an active AMC contract
  const { count } = await supabase
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("linked_asset_id", data.id)
    .eq("po_type", "service")
    .in("amc_status", ["active", "expiring"]);

  return NextResponse.json({
    data: {
      id: data.id,
      name: data.name,
      asset_code: data.asset_code,
      status: data.status,
      location_name: loc?.name || null,
      floor_name: flr?.name || null,
      category_name: cat?.name || null,
      category_scope: cat?.scope || null,
      category_id: cat?.id || null,
      location_id: loc?.id || null,
      floor_id: flr?.id || null,
      has_active_amc: (count || 0) > 0,
    },
  });
}

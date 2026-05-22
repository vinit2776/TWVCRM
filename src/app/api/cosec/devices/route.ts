import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** GET /api/cosec/devices?location_id=...&category=... — list enabled COSEC devices for a location */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const locationId = searchParams.get("location_id");
  const category   = searchParams.get("category"); // 'entry_point' | 'business_centre' | null (all)

  let query = supabase
    .from("cosec_devices")
    .select("id, label, device_ip, device_category")
    .eq("is_enabled", true)
    .order("label");

  if (locationId) query = query.eq("location_id", locationId);
  if (category)   query = query.eq("device_category", category);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}

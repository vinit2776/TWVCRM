import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — list services for a location
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const isActive = searchParams.get("is_active");

  let query = supabase
    .from("location_services")
    .select("*")
    .order("name");

  if (locationId) query = query.eq("location_id", locationId);
  if (isActive === "true") query = query.eq("is_active", true);
  if (isActive === "false") query = query.eq("is_active", false);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

// POST — create a new service (admin/manager only)
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin and managers can manage services" }, { status: 403 });
  }

  const body = await request.json();
  const { location_id, name, unit, price_per_unit } = body;

  if (!location_id || !name?.trim() || !unit?.trim()) {
    return NextResponse.json({ error: "location_id, name, and unit are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("location_services")
    .insert({
      location_id,
      name: name.trim(),
      unit: unit.trim(),
      price_per_unit: Number(price_per_unit) || 0,
      created_by: dbUser.id,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "A service with this name already exists at this location" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}

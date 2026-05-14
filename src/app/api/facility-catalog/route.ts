import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// GET /api/facility-catalog?location_id=&include_inactive=true
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const includeInactive = searchParams.get("include_inactive") === "true";

  let query = supabase
    .from("facility_catalog")
    .select("id, location_id, name, unit, default_cost_per_unit, is_active, created_at")
    .order("name", { ascending: true });

  if (locationId) query = query.eq("location_id", locationId);
  if (!includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

// POST /api/facility-catalog
// Body: { location_id, name, unit, default_cost_per_unit }
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const { location_id, name, unit, default_cost_per_unit } = body;

  if (!location_id || !name?.trim() || !unit?.trim()) {
    return NextResponse.json({ error: "location_id, name, and unit are required" }, { status: 400 });
  }
  if (default_cost_per_unit == null || isNaN(Number(default_cost_per_unit)) || Number(default_cost_per_unit) < 0) {
    return NextResponse.json({ error: "default_cost_per_unit must be a non-negative number" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("facility_catalog")
    .insert({
      location_id,
      name: name.trim(),
      unit: unit.trim(),
      default_cost_per_unit: Number(default_cost_per_unit),
      created_by: dbUser.id,
    })
    .select("id, location_id, name, unit, default_cost_per_unit, is_active")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: `"${name}" already exists for this location` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "facility_catalog",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

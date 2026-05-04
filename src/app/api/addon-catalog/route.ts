import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const VALID_TYPES = ["extended_time", "service", "food_beverage", "other"] as const;

/**
 * GET /api/addon-catalog
 * Lists active catalog items. Returns global items + items for the requested
 * location (if any), with location-specific items taking precedence in display.
 *
 * Query: ?location_id=...&include_inactive=true&type=service
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const spaceId = searchParams.get("space_id");
  const locationId = searchParams.get("location_id");
  const type = searchParams.get("type");
  const includeInactive = searchParams.get("include_inactive") === "true";
  const templates = searchParams.get("templates") === "true";

  let query = supabase
    .from("addon_catalog")
    .select("*")
    .order("addon_type", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (!includeInactive) query = query.eq("is_active", true);
  if (type) query = query.eq("addon_type", type);

  // Scope rules (in priority order):
  //   ?space_id=X  → only this space's catalogue
  //   ?templates=true → only the template rows (space_id IS NULL)
  //   ?location_id=X (legacy) → location rows + global templates
  //   else → all rows
  if (spaceId) {
    query = query.eq("space_id", spaceId);
  } else if (templates) {
    query = query.is("space_id", null);
  } else if (locationId) {
    query = query.or(`location_id.eq.${locationId},location_id.is.null`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

/**
 * POST /api/addon-catalog  — admin/manager only
 * Body: { location_id?, addon_type, name, description?, unit_price, unit_label?, gst_rate?, sort_order? }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const { space_id, location_id, addon_type, name, description, unit_price, unit_label, gst_rate = 18, sort_order = 0 } = body;

  if (!addon_type || !VALID_TYPES.includes(addon_type)) {
    return NextResponse.json({ error: `addon_type must be one of: ${VALID_TYPES.join(", ")}` }, { status: 400 });
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (unit_price == null || isNaN(Number(unit_price)) || Number(unit_price) < 0) {
    return NextResponse.json({ error: "unit_price must be a non-negative number" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("addon_catalog")
    .insert({
      space_id: space_id || null,
      location_id: location_id || null,
      addon_type,
      name: name.trim(),
      description: description || null,
      unit_price: Number(unit_price),
      unit_label: unit_label || null,
      gst_rate: Number(gst_rate),
      sort_order: Number(sort_order),
      created_by: dbUser.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "addon_catalog",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

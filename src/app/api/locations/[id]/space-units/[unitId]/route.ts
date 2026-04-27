import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; unitId: string }> }
) {
  const { id, unitId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("space_units")
    .select(`
      *,
      floor:location_floors(id, name, floor_number),
      active_allocations:contract_space_allocations(
        id, status, start_date, end_date,
        contract:contracts(id, contract_number, title, status)
      )
    `)
    .eq("id", unitId)
    .eq("location_id", id)
    .single();

  if (error) return NextResponse.json({ error: "Space unit not found" }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; unitId: string }> }
) {
  const { id, unitId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  const VALID_TYPES = ["hot_desk", "dedicated_desk", "private_cabin", "managed_office", "business_centre"];

  if (body.name !== undefined)         updates.name = String(body.name).trim();
  if (body.code !== undefined)         updates.code = String(body.code).trim().toUpperCase();
  if (body.type !== undefined && VALID_TYPES.includes(body.type)) updates.type = body.type;
  if (body.capacity !== undefined)     updates.capacity = Number(body.capacity);
  if (body.area_sqft !== undefined)    updates.area_sqft = body.area_sqft ? Number(body.area_sqft) : null;
  if (body.monthly_rate !== undefined) updates.monthly_rate = body.monthly_rate == null ? null : Number(body.monthly_rate);
  if (body.daily_rate !== undefined)   updates.daily_rate = body.daily_rate ? Number(body.daily_rate) : null;
  if (body.hourly_rate !== undefined)  updates.hourly_rate = body.hourly_rate == null ? null : Number(body.hourly_rate);
  if (body.amenities !== undefined)    updates.amenities = body.amenities;
  if (body.notes !== undefined)        updates.notes = body.notes || null;
  if (body.color !== undefined)        updates.color = body.color || null;
  if (body.sort_order !== undefined)   updates.sort_order = Number(body.sort_order);
  if (body.floor_id !== undefined)     updates.floor_id = body.floor_id || null;
  if (body.is_active !== undefined)    updates.is_active = Boolean(body.is_active);

  // Grid position — used by drag-and-drop (minimal payload: { grid_col, grid_row })
  if (body.grid_col !== undefined)      updates.grid_col = Number(body.grid_col);
  if (body.grid_row !== undefined)      updates.grid_row = Number(body.grid_row);
  if (body.grid_col_span !== undefined) updates.grid_col_span = Number(body.grid_col_span);
  if (body.grid_row_span !== undefined) updates.grid_row_span = Number(body.grid_row_span);

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("space_units")
    .update(updates)
    .eq("id", unitId)
    .eq("location_id", id)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "A unit with this code already exists at this location" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "space_unit",
    entityId: unitId,
    action: "update",
    performedBy: dbUser.id,
    changes: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { old: null, new: v }])),
  });

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; unitId: string }> }
) {
  const { id, unitId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  // Soft delete
  const { data, error } = await supabase
    .from("space_units")
    .update({ is_active: false })
    .eq("id", unitId)
    .eq("location_id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "space_unit",
    entityId: unitId,
    action: "delete",
    performedBy: dbUser.id,
    changes: { is_active: { old: true, new: false } },
  });

  return NextResponse.json({ data });
}

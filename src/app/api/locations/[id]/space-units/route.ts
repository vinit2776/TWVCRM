import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const VALID_TYPES = ["hot_desk", "dedicated_desk", "private_cabin", "managed_office", "business_centre"];
const HOURLY_TYPES = new Set(["business_centre"]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const floorId = searchParams.get("floor_id");
  const type = searchParams.get("type");
  const isActive = searchParams.get("is_active");

  let query = supabase
    .from("space_units")
    .select(`
      *,
      floor:location_floors(id, name, floor_number),
      active_allocations:contract_space_allocations(
        id, status, start_date, end_date,
        contract:contracts(id, contract_number, title, status, start_date, end_date)
      )
    `)
    .eq("location_id", id)
    .eq("active_allocations.status", "active")
    .order("sort_order", { ascending: true })
    .order("code", { ascending: true });

  if (floorId) query = query.eq("floor_id", floorId);
  if (type && VALID_TYPES.includes(type)) query = query.eq("type", type);
  if (isActive !== null) query = query.eq("is_active", isActive === "true");

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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
  const {
    floor_id, name, code, type, capacity, area_sqft, monthly_rate, daily_rate, hourly_rate,
    amenities, notes, grid_col, grid_row, grid_col_span, grid_row_span, color, sort_order,
  } = body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!code || typeof code !== "string" || code.trim() === "") {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }
  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: `Type must be one of: ${VALID_TYPES.join(", ")}` }, { status: 400 });
  }
  const isHourly = HOURLY_TYPES.has(type);
  if (isHourly) {
    if (!hourly_rate && hourly_rate !== 0) {
      return NextResponse.json({ error: "hourly_rate is required for business_centre" }, { status: 400 });
    }
  } else {
    if (!monthly_rate && monthly_rate !== 0) {
      return NextResponse.json({ error: "monthly_rate is required" }, { status: 400 });
    }
  }

  // Validate grid bounds against floor
  if (floor_id) {
    const { data: floor } = await supabase
      .from("location_floors")
      .select("grid_cols, grid_rows")
      .eq("id", floor_id)
      .single();

    if (floor) {
      const colSpan = Number(grid_col_span ?? 2);
      const rowSpan = Number(grid_row_span ?? 2);
      const col = Number(grid_col ?? 1);
      const row = Number(grid_row ?? 1);
      if (col + colSpan - 1 > floor.grid_cols) {
        return NextResponse.json({ error: "Unit extends beyond floor grid width" }, { status: 400 });
      }
      if (row + rowSpan - 1 > floor.grid_rows) {
        return NextResponse.json({ error: "Unit extends beyond floor grid height" }, { status: 400 });
      }
    }
  }

  const { data, error } = await supabase
    .from("space_units")
    .insert({
      location_id: id,
      floor_id: floor_id || null,
      name: name.trim(),
      code: String(code).trim().toUpperCase(),
      type,
      capacity: Number(capacity ?? 1),
      area_sqft: area_sqft ? Number(area_sqft) : null,
      monthly_rate: isHourly ? null : (monthly_rate != null ? Number(monthly_rate) : null),
      daily_rate: daily_rate ? Number(daily_rate) : null,
      hourly_rate: hourly_rate != null ? Number(hourly_rate) : null,
      amenities: amenities || [],
      notes: notes || null,
      grid_col: Number(grid_col ?? 1),
      grid_row: Number(grid_row ?? 1),
      grid_col_span: Number(grid_col_span ?? 2),
      grid_row_span: Number(grid_row_span ?? 2),
      color: color || null,
      sort_order: Number(sort_order ?? 0),
    })
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
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

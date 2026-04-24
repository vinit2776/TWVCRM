import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("location_floors")
    .select("*, space_units(count)")
    .eq("location_id", id)
    .order("sort_order", { ascending: true })
    .order("floor_number", { ascending: true });

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
  const { name, floor_number, total_area_sqft, leasable_area_sqft, grid_cols, grid_rows, sort_order } = body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return NextResponse.json({ error: "Floor name is required" }, { status: 400 });
  }

  const cols = Number(grid_cols ?? 20);
  const rows = Number(grid_rows ?? 12);
  if (cols < 10 || cols > 30) return NextResponse.json({ error: "grid_cols must be between 10 and 30" }, { status: 400 });
  if (rows < 8  || rows > 20) return NextResponse.json({ error: "grid_rows must be between 8 and 20" }, { status: 400 });

  const totalArea = Number(total_area_sqft ?? 0);
  const leasableArea = Number(leasable_area_sqft ?? 0);
  if (leasableArea > totalArea && totalArea > 0) {
    return NextResponse.json({ error: "Leasable area cannot exceed total area" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("location_floors")
    .insert({
      location_id: id,
      name: name.trim(),
      floor_number: floor_number !== undefined ? Number(floor_number) : null,
      total_area_sqft: totalArea,
      leasable_area_sqft: leasableArea,
      grid_cols: cols,
      grid_rows: rows,
      sort_order: Number(sort_order ?? 0),
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "location_floor",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

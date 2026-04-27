import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; floorId: string }> }
) {
  const { id, floorId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("location_floors")
    .select("*, space_units(*)")
    .eq("id", floorId)
    .eq("location_id", id)
    .single();

  if (error) return NextResponse.json({ error: "Floor not found" }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; floorId: string }> }
) {
  const { id, floorId } = await params;
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

  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.floor_number !== undefined) updates.floor_number = body.floor_number !== null ? Number(body.floor_number) : null;
  if (body.total_area_sqft !== undefined) updates.total_area_sqft = Number(body.total_area_sqft);
  if (body.leasable_area_sqft !== undefined) updates.leasable_area_sqft = Number(body.leasable_area_sqft);
  if (body.sort_order !== undefined) updates.sort_order = Number(body.sort_order);

  if (body.grid_cols !== undefined) {
    const cols = Number(body.grid_cols);
    if (cols < 10 || cols > 30) return NextResponse.json({ error: "grid_cols must be 10–30" }, { status: 400 });
    updates.grid_cols = cols;
  }
  if (body.grid_rows !== undefined) {
    const rows = Number(body.grid_rows);
    if (rows < 8 || rows > 20) return NextResponse.json({ error: "grid_rows must be 8–20" }, { status: 400 });
    updates.grid_rows = rows;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("location_floors")
    .update(updates)
    .eq("id", floorId)
    .eq("location_id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "location_floor",
    entityId: floorId,
    action: "update",
    performedBy: dbUser.id,
    changes: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { old: null, new: v }])),
  });

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; floorId: string }> }
) {
  const { id, floorId } = await params;
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

  const { error } = await supabase
    .from("location_floors")
    .delete()
    .eq("id", floorId)
    .eq("location_id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "location_floor",
    entityId: floorId,
    action: "delete",
    performedBy: dbUser.id,
    changes: { deleted: { old: floorId, new: null } },
  });

  return NextResponse.json({ success: true });
}

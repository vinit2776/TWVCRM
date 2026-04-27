import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ id: string; occupantId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id, occupantId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const updates: Record<string, unknown> = {};
  if (body.occupant_name !== undefined) updates.occupant_name = String(body.occupant_name).trim();
  if (body.occupant_email !== undefined) updates.occupant_email = body.occupant_email?.trim() || null;
  if (body.occupant_phone !== undefined) updates.occupant_phone = body.occupant_phone?.trim() || null;
  if (body.seat_label !== undefined) updates.seat_label = body.seat_label?.trim() || null;
  if (body.start_date !== undefined) updates.start_date = body.start_date;
  if (body.end_date !== undefined) updates.end_date = body.end_date || null;
  if (body.notes !== undefined) updates.notes = body.notes?.trim() || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("space_seat_occupants")
    .update(updates)
    .eq("id", occupantId)
    .eq("contract_id", id)
    .select(`
      *,
      space_unit:space_units(id, name, code, type, capacity, floor_id,
        floor:location_floors(id, name))
    `)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "space_seat_occupant",
    entityId: occupantId,
    action: "update",
    performedBy: dbUser.id,
    changes: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { old: null, new: v }])),
  });

  return NextResponse.json({ data });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id, occupantId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Soft-end the occupancy
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("space_seat_occupants")
    .update({ status: "ended", end_date: today })
    .eq("id", occupantId)
    .eq("contract_id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "space_seat_occupant",
    entityId: occupantId,
    action: "update",
    performedBy: dbUser.id,
    changes: { status: { old: "active", new: "ended" }, end_date: { old: null, new: today } },
  });

  return NextResponse.json({ data });
}

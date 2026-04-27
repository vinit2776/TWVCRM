import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const spaceUnitId = searchParams.get("space_unit_id");
  const status = searchParams.get("status") || "active"; // active | ended | all

  let query = supabase
    .from("space_seat_occupants")
    .select(`
      *,
      space_unit:space_units(id, name, code, type, capacity, floor_id,
        floor:location_floors(id, name))
    `)
    .eq("contract_id", id)
    .order("occupant_name", { ascending: true });

  if (spaceUnitId) query = query.eq("space_unit_id", spaceUnitId);
  if (status !== "all") query = query.eq("status", status);

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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const { space_unit_id, occupant_name, occupant_email, occupant_phone, seat_label, start_date, notes } = body;

  if (!space_unit_id) return NextResponse.json({ error: "space_unit_id is required" }, { status: 400 });
  if (!occupant_name?.trim()) return NextResponse.json({ error: "occupant_name is required" }, { status: 400 });

  // Resolve location_id from the contract
  const { data: contract } = await supabase
    .from("contracts")
    .select("id, location_id")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (!contract.location_id) return NextResponse.json({ error: "Contract has no location assigned" }, { status: 400 });

  // Validate the space unit belongs to the same location
  const { data: unit } = await supabase
    .from("space_units")
    .select("id, location_id")
    .eq("id", space_unit_id)
    .single();
  if (!unit) return NextResponse.json({ error: "Space unit not found" }, { status: 404 });
  if (unit.location_id !== contract.location_id) {
    return NextResponse.json({ error: "Space unit does not belong to this contract's location" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("space_seat_occupants")
    .insert({
      space_unit_id,
      contract_id: id,
      location_id: contract.location_id,
      seat_label: seat_label?.trim() || null,
      occupant_name: occupant_name.trim(),
      occupant_email: occupant_email?.trim() || null,
      occupant_phone: occupant_phone?.trim() || null,
      start_date: start_date || new Date().toISOString().split("T")[0],
      notes: notes?.trim() || null,
    })
    .select(`
      *,
      space_unit:space_units(id, name, code, type, capacity, floor_id,
        floor:location_floors(id, name))
    `)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "space_seat_occupant",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

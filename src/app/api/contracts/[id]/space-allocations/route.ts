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
    .from("contract_space_allocations")
    .select(`
      *,
      space_unit:space_units(
        id, name, code, type, capacity, monthly_rate, area_sqft, color,
        floor:location_floors(id, name, floor_number)
      )
    `)
    .eq("contract_id", id)
    .order("created_at", { ascending: true });

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

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { space_unit_id, start_date, end_date, notes } = body;

  if (!space_unit_id) return NextResponse.json({ error: "space_unit_id is required" }, { status: 400 });
  if (!start_date) return NextResponse.json({ error: "start_date is required" }, { status: 400 });

  // Validate: space unit must belong to the same location as the contract
  const [contractResult, unitResult] = await Promise.all([
    supabase.from("contracts").select("location_id").eq("id", id).single(),
    supabase.from("space_units").select("location_id").eq("id", space_unit_id).single(),
  ]);

  if (contractResult.error || !contractResult.data) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  if (unitResult.error || !unitResult.data) {
    return NextResponse.json({ error: "Space unit not found" }, { status: 404 });
  }
  if (contractResult.data.location_id !== unitResult.data.location_id) {
    return NextResponse.json({ error: "Space unit does not belong to the contract's location" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("contract_space_allocations")
    .insert({
      contract_id: id,
      space_unit_id,
      start_date,
      end_date: end_date || null,
      status: "active",
      notes: notes || null,
    })
    .select(`
      *,
      space_unit:space_units(id, name, code, type, capacity, monthly_rate, color,
        floor:location_floors(id, name, floor_number))
    `)
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "This space unit is already allocated to this contract" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract_space_allocation",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

export async function DELETE(
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

  const { searchParams } = new URL(request.url);
  const allocationId = searchParams.get("allocation_id");
  if (!allocationId) return NextResponse.json({ error: "allocation_id query param is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("contract_space_allocations")
    .update({ status: "ended" })
    .eq("id", allocationId)
    .eq("contract_id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract_space_allocation",
    entityId: allocationId,
    action: "delete",
    performedBy: dbUser.id,
    changes: { status: { old: "active", new: "ended" } },
  });

  return NextResponse.json({ data });
}

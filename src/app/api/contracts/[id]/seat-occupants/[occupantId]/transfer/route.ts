/**
 * POST /api/contracts/[id]/seat-occupants/[occupantId]/transfer
 *
 * Shifts a person to a different space unit.
 * - Ends the current record (status='transferred', end_date=transfer_date)
 * - Creates a new record in the target unit (same person details, new start_date)
 * - Links old→new via transferred_to_id
 *
 * Body: { new_space_unit_id, new_contract_id?, transfer_date?, seat_label?, notes? }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ id: string; occupantId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id, occupantId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const { new_space_unit_id, new_contract_id, transfer_date, seat_label, notes } = body;

  if (!new_space_unit_id) {
    return NextResponse.json({ error: "new_space_unit_id is required" }, { status: 400 });
  }

  // Fetch the current occupant record
  const { data: current, error: fetchError } = await supabase
    .from("space_seat_occupants")
    .select("*")
    .eq("id", occupantId)
    .eq("contract_id", id)
    .eq("status", "active")
    .single();

  if (fetchError || !current) {
    return NextResponse.json({ error: "Active occupant record not found" }, { status: 404 });
  }

  // Validate the target unit belongs to the same location
  const { data: targetUnit } = await supabase
    .from("space_units")
    .select("id, location_id, is_active")
    .eq("id", new_space_unit_id)
    .single();

  if (!targetUnit) return NextResponse.json({ error: "Target space unit not found" }, { status: 404 });
  if (!targetUnit.is_active) return NextResponse.json({ error: "Target space unit is inactive" }, { status: 400 });
  if (targetUnit.location_id !== current.location_id) {
    return NextResponse.json({ error: "Target unit must be at the same location" }, { status: 400 });
  }
  if (new_space_unit_id === current.space_unit_id) {
    return NextResponse.json({ error: "Target unit is the same as the current unit" }, { status: 400 });
  }

  const effectiveDate = transfer_date || new Date().toISOString().split("T")[0];
  const targetContractId = new_contract_id || id; // default: keep under the same contract

  // Create the new occupant record first
  const { data: newRecord, error: insertError } = await supabase
    .from("space_seat_occupants")
    .insert({
      space_unit_id: new_space_unit_id,
      contract_id: targetContractId,
      location_id: current.location_id,
      seat_label: seat_label?.trim() || null,
      occupant_name: current.occupant_name,
      occupant_email: current.occupant_email,
      occupant_phone: current.occupant_phone,
      start_date: effectiveDate,
      notes: notes?.trim() || null,
    })
    .select(`
      *,
      space_unit:space_units(id, name, code, type, capacity, floor_id,
        floor:location_floors(id, name))
    `)
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  // Close out the old record, linking to the new one
  const { data: oldRecord, error: updateError } = await supabase
    .from("space_seat_occupants")
    .update({
      status: "transferred",
      end_date: effectiveDate,
      transferred_to_id: newRecord.id,
    })
    .eq("id", occupantId)
    .select()
    .single();

  if (updateError) {
    // Best-effort rollback of the new record
    await supabase.from("space_seat_occupants").delete().eq("id", newRecord.id);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "space_seat_occupant",
    entityId: occupantId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "active", new: "transferred" },
      transferred_to_id: { old: null, new: newRecord.id },
      new_space_unit_id: { old: current.space_unit_id, new: new_space_unit_id },
    },
  });

  return NextResponse.json({ old: oldRecord, new: newRecord });
}

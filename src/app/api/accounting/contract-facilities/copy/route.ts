import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const body = await request.json();
  const { source_contract_id, target_contract_id } = body as {
    source_contract_id: string;
    target_contract_id: string;
  };

  if (!source_contract_id || !target_contract_id) {
    return NextResponse.json({ error: "source_contract_id and target_contract_id are required" }, { status: 400 });
  }

  if (source_contract_id === target_contract_id) {
    return NextResponse.json({ error: "Source and target contracts must be different" }, { status: 400 });
  }

  // Fetch active facilities from source contract
  const { data: sourceFacilities, error: fetchError } = await supabase
    .from("contract_facilities")
    .select("name, unit, cost_per_unit, free_quota")
    .eq("contract_id", source_contract_id)
    .eq("is_active", true);

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!sourceFacilities || sourceFacilities.length === 0) {
    return NextResponse.json({ error: "No active facilities found on source contract" }, { status: 404 });
  }

  // Fetch existing facility names on target to skip duplicates
  const { data: targetFacilities } = await supabase
    .from("contract_facilities")
    .select("name")
    .eq("contract_id", target_contract_id)
    .eq("is_active", true);

  const existingNames = new Set((targetFacilities || []).map((f) => f.name));

  // Filter out already-existing facilities
  const facilitiesToCopy = sourceFacilities.filter((f) => !existingNames.has(f.name));

  if (facilitiesToCopy.length === 0) {
    return NextResponse.json({ data: [], message: "All facilities already exist on target contract", count: 0 });
  }

  // Insert new facilities
  const inserts = facilitiesToCopy.map((f) => ({
    contract_id: target_contract_id,
    name: f.name,
    unit: f.unit,
    cost_per_unit: f.cost_per_unit,
    free_quota: f.free_quota,
    created_by: dbUser?.id,
  }));

  const { data: inserted, error: insertError } = await supabase
    .from("contract_facilities")
    .insert(inserts)
    .select("*");

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract_facility",
      entityId: target_contract_id,
      action: "create",
      performedBy: dbUser.id,
      changes: { bulk_copy: { old: null, new: { source: source_contract_id, count: inserted?.length || 0 } } },
    });
  }

  return NextResponse.json({ data: inserted, count: inserted?.length || 0 }, { status: 201 });
}

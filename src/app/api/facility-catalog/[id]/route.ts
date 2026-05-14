import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// PATCH /api/facility-catalog/[id]
// Body: { name?, unit?, default_cost_per_unit?, is_active? }
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.unit !== undefined) updates.unit = String(body.unit).trim();
  if (body.default_cost_per_unit !== undefined) updates.default_cost_per_unit = Number(body.default_cost_per_unit);
  if (body.is_active !== undefined) updates.is_active = Boolean(body.is_active);
  updates.updated_at = new Date().toISOString();

  const { data: prev } = await supabase.from("facility_catalog").select("*").eq("id", id).single();

  const { data, error } = await supabase
    .from("facility_catalog")
    .update(updates)
    .eq("id", id)
    .select("id, location_id, name, unit, default_cost_per_unit, is_active")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_catalog",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { record: { old: prev, new: data } },
  });

  return NextResponse.json({ data });
}

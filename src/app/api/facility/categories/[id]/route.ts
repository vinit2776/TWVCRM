import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.manage)) {
    return NextResponse.json({ error: "Admin or IT Manager access required" }, { status: 403 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};
  const fields = [
    "name", "icon", "description", "is_active", "sort_order",
    "default_sla_critical_hrs", "default_sla_high_hrs",
    "default_sla_medium_hrs", "default_sla_low_hrs",
  ];
  for (const f of fields) if (f in body) updates[f] = body[f];

  const { data, error } = await supabase
    .from("facility_asset_categories")
    .update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_asset_category",
    entityId: id,
    action: "update",
    performedBy: dbUser!.id,
    changes: { record: { old: null, new: data } },
  });

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.manage)) {
    return NextResponse.json({ error: "Admin or IT Manager access required" }, { status: 403 });
  }

  // Soft delete
  const { error } = await supabase
    .from("facility_asset_categories")
    .update({ is_active: false }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_asset_category",
    entityId: id,
    action: "delete",
    performedBy: dbUser!.id,
  });

  return NextResponse.json({ success: true });
}

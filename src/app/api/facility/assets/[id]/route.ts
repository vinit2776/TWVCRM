import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: asset, error } = await supabase
    .from("facility_assets")
    .select(`
      *,
      location:locations(id, name, code),
      floor:location_floors(id, name),
      space_unit:space_units(id, name, code),
      category:facility_asset_categories(*)
    `)
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "PGRST116" ? 404 : 500 });

  // Issue history
  const { data: issues } = await supabase
    .from("facility_issues")
    .select("id, issue_number, title, status, priority, created_at, resolved_at, sla_breached")
    .eq("asset_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ data: { ...asset, issue_history: issues || [] } });
}

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
  if (!hasRole(dbUser?.role, FACILITY_ROLES.workOnIssues)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};
  const allowed = [
    "floor_id", "space_unit_id", "category_id", "name", "asset_code",
    "make", "model", "serial_number", "mac_address", "ip_address",
    "purchase_date", "warranty_expiry", "vendor", "status",
    "lifecycle_stage", "installation_date", "commissioned_at", "commissioned_by",
    "custom_field_values", "procurement_po_id",
    "location_notes", "notes", "sort_order",
  ];
  for (const f of allowed) if (f in body) updates[f] = body[f];
  if (typeof updates.asset_code === "string") {
    updates.asset_code = (updates.asset_code as string).trim().toUpperCase();
  }
  if (typeof updates.name === "string") {
    updates.name = (updates.name as string).trim();
  }

  const { data, error } = await supabase
    .from("facility_assets")
    .update(updates).eq("id", id).select().single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "An asset with this code already exists at this location" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "facility_asset", entityId: id, action: "update",
    performedBy: dbUser!.id, changes: { record: { old: null, new: data } },
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

  // Soft delete via status flag
  const { error } = await supabase
    .from("facility_assets")
    .update({ status: "retired" }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_asset", entityId: id, action: "delete", performedBy: dbUser!.id,
  });

  return NextResponse.json({ success: true });
}

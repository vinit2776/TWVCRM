import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const VALID_ROLES = [
  "admin", "manager", "sales_rep", "floor_manager", "accounts",
  "fms", "office_admin", "it_manager", "it_technician", "viewer",
];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check if current user is admin
  const { data: currentUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can update user roles" }, { status: 403 });
  }

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};

  if (body.role && VALID_ROLES.includes(body.role)) {
    allowedFields.role = body.role;
  }
  if (typeof body.is_active === "boolean") {
    allowedFields.is_active = body.is_active;
  }

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Fetch current values for audit diff
  const { data: before } = await admin
    .from("users")
    .select("role, is_active")
    .eq("id", id)
    .single();

  const { data, error } = await admin
    .from("users")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit trail — role/status changes are security-critical
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  if (allowedFields.role !== undefined) changes.role = { old: before?.role ?? null, new: allowedFields.role };
  if (allowedFields.is_active !== undefined) changes.is_active = { old: before?.is_active ?? null, new: allowedFields.is_active };

  logAudit(admin, {
    entityType: "user",
    entityId: id,
    action: "update",
    performedBy: user.id,
    changes,
  });

  return NextResponse.json({ data });
}

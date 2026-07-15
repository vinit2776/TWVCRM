import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";

/**
 * POST /api/facility/departments/[id]/members
 * Adds one or more users to a department's roster. Informational only —
 * membership does not restrict who can claim/be assigned a ticket.
 */
export async function POST(
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
  const userIds: string[] = Array.isArray(body.user_ids) ? body.user_ids : [body.user_id].filter(Boolean);
  if (!userIds.length) {
    return NextResponse.json({ error: "user_id or user_ids required" }, { status: 400 });
  }

  const rows = userIds.map((uid) => ({
    department_id: id,
    user_id: uid,
    added_by: dbUser!.id,
  }));

  const { data, error } = await supabase
    .from("facility_department_members")
    .upsert(rows, { onConflict: "department_id,user_id", ignoreDuplicates: true })
    .select("id, user_id, added_at, user:users!facility_department_members_user_id_fkey(id, full_name, email, role)");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_department_member",
    entityId: id,
    action: "create",
    performedBy: dbUser!.id,
    changes: { members_added: { old: null, new: userIds } },
  });

  return NextResponse.json({ data: data ?? [] }, { status: 201 });
}

/**
 * DELETE /api/facility/departments/[id]/members
 * Removes a user from a department's roster. Body: { user_id }.
 */
export async function DELETE(
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
  const userId = body.user_id;
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

  const { error } = await supabase
    .from("facility_department_members")
    .delete()
    .eq("department_id", id)
    .eq("user_id", userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_department_member",
    entityId: id,
    action: "delete",
    performedBy: dbUser!.id,
    changes: { member_removed: { old: userId, new: null } },
  });

  return NextResponse.json({ success: true });
}

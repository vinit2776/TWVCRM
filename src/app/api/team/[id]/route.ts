import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";

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
    return NextResponse.json({ error: "Only admins can manage users" }, { status: 403 });
  }

  const body = await request.json();

  // Get the target user's auth_id for auth operations
  const { data: targetUser } = await supabase
    .from("users")
    .select("auth_id")
    .eq("id", id)
    .single();

  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Handle password change via admin API
  if (body.password) {
    if (body.password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters" },
        { status: 400 }
      );
    }

    const adminSupabase = await createAdminClient();
    const { error: pwError } = await adminSupabase.auth.admin.updateUserById(
      targetUser.auth_id,
      { password: body.password }
    );

    if (pwError) {
      return NextResponse.json({ error: pwError.message }, { status: 400 });
    }

    // If only password change, log and return early
    if (!body.role && typeof body.is_active !== "boolean" && !body.full_name && !body.phone) {
      const { data: adminDbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
      if (adminDbUser?.id) {
        logAudit(supabase, {
          entityType: "user",
          entityId: id,
          action: "update",
          performedBy: adminDbUser.id,
          changes: { password: { old: "***", new: "***" } },
        });
      }
      return NextResponse.json({ message: "Password updated successfully" });
    }
  }

  // Handle profile and role updates
  const allowedFields: Record<string, unknown> = {};

  if (body.role && ["admin", "manager", "sales_rep", "floor_manager", "accounts", "fms", "office_admin"].includes(body.role)) {
    allowedFields.role = body.role;
  }
  if (typeof body.is_active === "boolean") {
    allowedFields.is_active = body.is_active;
  }
  if (body.full_name && typeof body.full_name === "string") {
    allowedFields.full_name = body.full_name.trim();
  }
  if (typeof body.phone === "string") {
    allowedFields.phone = body.phone.trim() || null;
  }

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ message: "No profile changes to apply" });
  }

  const { data: oldUser } = await supabase.from("users").select("*").eq("id", id).single();

  const { data, error } = await supabase
    .from("users")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: adminDbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (adminDbUser?.id && oldUser) {
    const changes = diffChanges(oldUser as Record<string, unknown>, allowedFields);
    if (body.password) changes.password = { old: "***", new: "***" };
    logAudit(supabase, {
      entityType: "user",
      entityId: id,
      action: "update",
      performedBy: adminDbUser.id,
      changes,
    });
  }

  return NextResponse.json({ data });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function POST(request: NextRequest) {
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
    return NextResponse.json({ error: "Only admins can create users" }, { status: 403 });
  }

  const body = await request.json();
  const { email, full_name, password, role, phone } = body;

  if (!email || !full_name || !password) {
    return NextResponse.json(
      { error: "Email, full name, and password are required" },
      { status: 400 }
    );
  }

  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  const validRoles = ["admin", "manager", "sales_rep"];
  const userRole = validRoles.includes(role) ? role : "sales_rep";

  // Use admin client to create auth user
  const adminSupabase = await createAdminClient();

  const { data: authData, error: authError } = await adminSupabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // Auto-confirm email so they can login immediately
    user_metadata: { full_name },
  });

  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 400 });
  }

  // The trigger should auto-create the user record, but let's update the role and other fields
  // Wait a moment for the trigger to fire, then update
  if (authData.user) {
    // Update user record with role and phone (trigger creates with default sales_rep)
    const { error: updateError } = await adminSupabase
      .from("users")
      .update({
        role: userRole,
        phone: phone || null,
        full_name,
      })
      .eq("auth_id", authData.user.id);

    if (updateError) {
      // If trigger hasn't fired yet, insert manually
      await adminSupabase.from("users").insert({
        auth_id: authData.user.id,
        email,
        full_name,
        phone: phone || null,
        role: userRole,
        is_active: true,
      });
    }
  }

  // Audit log: get the admin's internal ID and the new user's ID
  const { data: adminDbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (adminDbUser?.id && authData.user) {
    const { data: newDbUser } = await adminSupabase.from("users").select("id").eq("auth_id", authData.user.id).single();
    if (newDbUser) {
      logAudit(supabase, {
        entityType: "user",
        entityId: newDbUser.id,
        action: "create",
        performedBy: adminDbUser.id,
        changes: { record: { old: null, new: { email, full_name, role: userRole } } },
      });
    }
  }

  return NextResponse.json(
    { message: "User created successfully" },
    { status: 201 }
  );
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { updateSpaceSchema } from "@/lib/validations";
import { logAudit, diffChanges } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("spaces")
    .select("*, location:locations!spaces_location_id_fkey(id, name, code, address, city, state), facilities:space_facilities(*)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: "Space not found" }, { status: 404 });

  return NextResponse.json({ data });
}

export async function PATCH(
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

  if (!dbUser || !["admin", "manager", "floor_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const result = updateSpaceSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const { facilities, ...spaceData } = result.data;

  // Fetch old record for audit
  const { data: oldSpace } = await supabase.from("spaces").select("*").eq("id", id).single();
  if (!oldSpace) return NextResponse.json({ error: "Space not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("spaces")
    .update(spaceData)
    .eq("id", id)
    .select("*, location:locations!spaces_location_id_fkey(id, name, code), facilities:space_facilities(*)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (dbUser.id) {
    logAudit(supabase, {
      entityType: "space",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldSpace, data),
    });
  }

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
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can disable spaces" }, { status: 403 });
  }

  // Check for active bookings
  const { count } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("space_id", id)
    .in("status", ["confirmed", "checked_in"]);

  if (count && count > 0) {
    return NextResponse.json({
      error: `Cannot disable: ${count} active booking(s) exist for this space`,
    }, { status: 400 });
  }

  // Soft delete
  const { error } = await supabase
    .from("spaces")
    .update({ is_active: false })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "space",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { is_active: { old: true, new: false } },
  });

  return NextResponse.json({ message: "Space disabled" });
}

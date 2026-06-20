import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const ADMIN_ROLES = ["admin", "manager", "office_admin"] as const;

const updateSchema = z.object({
  responsibility: z.enum(["primary", "secondary"]),
});

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ADMIN_ROLES.includes(dbUser.role as typeof ADMIN_ROLES[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: existing } = await supabase.from("user_locations").select("id, user_id, location_id").eq("id", id).single();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error } = await supabase.from("user_locations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "user_location",
    entityId: id,
    action: "delete",
    performedBy: dbUser.id,
    changes: { user_id: { old: existing.user_id, new: null }, location_id: { old: existing.location_id, new: null } },
  });

  return NextResponse.json({ data: { id } });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ADMIN_ROLES.includes(dbUser.role as typeof ADMIN_ROLES[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("user_locations")
    .update(parsed.data)
    .eq("id", id)
    .select("id, responsibility")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "user_location",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { responsibility: { old: null, new: parsed.data.responsibility } },
  });

  return NextResponse.json({ data });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const ADMIN_ROLES = ["admin", "manager", "office_admin"] as const;

const createSchema = z.object({
  user_id: z.string().uuid(),
  location_id: z.string().uuid(),
  responsibility: z.enum(["primary", "secondary"]).default("primary"),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ADMIN_ROLES.includes(dbUser.role as typeof ADMIN_ROLES[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");

  let query = supabase
    .from("user_locations")
    .select(`
      id,
      user_id,
      location_id,
      responsibility,
      created_at,
      user:users!user_locations_user_id_fkey(id, full_name, email, role),
      location:locations!user_locations_location_id_fkey(id, name)
    `)
    .order("created_at", { ascending: false });

  if (locationId) query = query.eq("location_id", locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ADMIN_ROLES.includes(dbUser.role as typeof ADMIN_ROLES[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { data, error } = await supabase
    .from("user_locations")
    .insert({ ...parsed.data })
    .select("id, user_id, location_id, responsibility")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "This user is already assigned to this location" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: "user_location",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { user_id: { old: null, new: parsed.data.user_id }, location_id: { old: null, new: parsed.data.location_id } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

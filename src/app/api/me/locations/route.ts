import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/me/locations
 * Returns the CURRENT user's own location assignments (from user_locations).
 * Accessible to any authenticated user — unlike /api/admin/user-locations,
 * which is admin-only. Used to scope Inventory / Transfers / Consumption to the
 * locations a user is responsible for.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data, error } = await supabase
    .from("user_locations")
    .select("id, location_id, responsibility, location:locations(id, name, code)")
    .eq("user_id", dbUser.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [], role: dbUser.role });
}

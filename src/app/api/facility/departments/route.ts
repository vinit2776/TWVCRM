import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/facility/departments
 * Lists the 8 scope-mapped departments with their head + member roster.
 * Read access is open to any authenticated user (mirrors facility_asset_categories).
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("facility_departments")
    .select(`
      *,
      head:users!facility_departments_head_user_id_fkey(id, full_name, email, role),
      members:facility_department_members(id, department_id, user_id, added_by, added_at,
        user:users!facility_department_members_user_id_fkey(id, full_name, email, role))
    `)
    .order("scope", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

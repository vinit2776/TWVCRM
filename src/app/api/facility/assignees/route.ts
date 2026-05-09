import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { IT_NOTIFY_EMAILS } from "@/lib/facility-notifications";

/**
 * GET /api/facility/assignees
 * Returns active users that can be assigned to facility issues
 * (it_technician, it_manager, admins, plus the designated IT team contacts).
 */
export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("users")
    .select("id, full_name, email, role")
    .or(`role.in.(it_technician,it_manager,admin),email.in.(${IT_NOTIFY_EMAILS.join(",")})`)
    .eq("is_active", true)
    .order("full_name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Deduplicate in case an IT contact already has a matching role
  const seen = new Set<string>();
  const unique = (data || []).filter((u) => {
    if (seen.has(u.id)) return false;
    seen.add(u.id);
    return true;
  });

  return NextResponse.json({ data: unique });
}

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/leads/jobs
// The hand-over jobs that involve the signed-in person: given to them, or handed over by them. The
// Leads Home sorts them into You need to do / Waiting on others / Done by others. Read-only.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (!me) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, kind, title, status, due_date, created_at, completed_at, completion_note, brief, assigned_to, handed_over_by, " +
        "assignee:users!tasks_assigned_to_fkey(id, full_name), giver:users!tasks_handed_over_by_fkey(id, full_name), " +
        "lead:leads!tasks_lead_id_fkey(id, first_name, last_name)",
    )
    .neq("kind", "general")
    .or(`assigned_to.eq.${me.id},handed_over_by.eq.${me.id}`)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[leads/jobs] load failed", error.code, error.message);
    return NextResponse.json({ error: "Could not load the jobs" }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] });
}

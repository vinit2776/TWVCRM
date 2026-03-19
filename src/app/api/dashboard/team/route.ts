import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/team?location_id=<uuid>
 * Returns per-user activity and task counts for the current ISO week.
 * Access: admin, manager only.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Current ISO week bounds (Monday 00:00 → Sunday 23:59)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sun
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() + diffToMonday);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  // Fetch all active users (users table has no location_id column)
  const { data: teamUsers } = await adminSupabase
    .from("users")
    .select("id, full_name, role")
    .eq("is_active", true)
    .order("full_name");
  if (!teamUsers || teamUsers.length === 0) {
    return NextResponse.json({ data: [] });
  }

  const userIds = teamUsers.map((u) => u.id);

  // Activities this week per user
  const { data: activitiesData } = await adminSupabase
    .from("activities")
    .select("created_by")
    .in("created_by", userIds)
    .gte("created_at", weekStart.toISOString())
    .lte("created_at", weekEnd.toISOString());

  // Tasks completed this week per user
  const { data: tasksData } = await adminSupabase
    .from("tasks")
    .select("assigned_to")
    .in("assigned_to", userIds)
    .eq("status", "done")
    .gte("updated_at", weekStart.toISOString())
    .lte("updated_at", weekEnd.toISOString());

  // Aggregate
  const activityCount: Record<string, number> = {};
  const taskCount: Record<string, number> = {};

  for (const a of activitiesData ?? []) {
    if (a.created_by) activityCount[a.created_by] = (activityCount[a.created_by] ?? 0) + 1;
  }
  for (const t of tasksData ?? []) {
    if (t.assigned_to) taskCount[t.assigned_to] = (taskCount[t.assigned_to] ?? 0) + 1;
  }

  const result = teamUsers.map((u) => ({
    user_id: u.id,
    full_name: u.full_name,
    role: u.role,
    activities_this_week: activityCount[u.id] ?? 0,
    tasks_completed_this_week: taskCount[u.id] ?? 0,
  }));

  // Sort by most active first
  result.sort((a, b) => b.activities_this_week - a.activities_this_week);

  return NextResponse.json({ data: result });
}

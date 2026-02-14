import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Pipeline counts
  const { data: pipeline } = await supabase
    .from("leads")
    .select("status")
    .then(({ data }) => {
      const counts: Record<string, number> = {};
      data?.forEach((l) => {
        counts[l.status] = (counts[l.status] || 0) + 1;
      });
      return {
        data: Object.entries(counts).map(([status, count]) => ({ status, count })),
      };
    });

  // Total leads
  const { count: totalLeads } = await supabase
    .from("leads")
    .select("*", { count: "exact", head: true });

  // Won/lost counts
  const { count: wonCount } = await supabase
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("status", "won");

  const { count: lostCount } = await supabase
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("status", "lost");

  // Tasks due today
  const today = new Date().toISOString().split("T")[0];
  const { count: tasksDueToday } = await supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .eq("due_date", today)
    .neq("status", "done");

  // Tasks overdue
  const { count: tasksOverdue } = await supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .lt("due_date", today)
    .neq("status", "done");

  // Recent activities
  const { data: recentActivities } = await supabase
    .from("activities")
    .select("*, creator:users!activities_created_by_fkey(full_name), lead:leads!activities_lead_id_fkey(first_name, last_name)")
    .order("created_at", { ascending: false })
    .limit(10);

  // Pending follow-ups
  const { count: pendingFollowUps } = await supabase
    .from("activities")
    .select("*", { count: "exact", head: true })
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null);

  const total = totalLeads || 0;
  const won = wonCount || 0;
  const lost = lostCount || 0;
  const rate = total > 0 ? Math.round((won / total) * 100) : 0;

  return NextResponse.json({
    data: {
      pipeline: pipeline || [],
      tasks_due_today: tasksDueToday || 0,
      tasks_overdue: tasksOverdue || 0,
      recent_activities: recentActivities || [],
      conversion: { total_leads: total, won, lost, rate },
      pending_follow_ups: pendingFollowUps || 0,
    },
  });
}

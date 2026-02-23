import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const locationId = request.nextUrl.searchParams.get("location_id");

  // If filtering by location, get lead IDs for that location first
  let locationLeadIds: string[] | null = null;
  if (locationId) {
    const { data: locationLeads } = await supabase
      .from("leads")
      .select("id")
      .eq("location_id", locationId);
    locationLeadIds = (locationLeads || []).map((l) => l.id);
  }

  // Pipeline counts
  let pipelineQuery = supabase.from("leads").select("status");
  if (locationId) pipelineQuery = pipelineQuery.eq("location_id", locationId);
  const { data: pipelineData } = await pipelineQuery;

  const pipelineCounts: Record<string, number> = {};
  pipelineData?.forEach((l) => {
    pipelineCounts[l.status] = (pipelineCounts[l.status] || 0) + 1;
  });
  const pipeline = Object.entries(pipelineCounts).map(([status, count]) => ({ status, count }));

  // Total leads
  let totalQuery = supabase.from("leads").select("*", { count: "exact", head: true });
  if (locationId) totalQuery = totalQuery.eq("location_id", locationId);
  const { count: totalLeads } = await totalQuery;

  // Won/lost counts
  let wonQuery = supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "won");
  if (locationId) wonQuery = wonQuery.eq("location_id", locationId);
  const { count: wonCount } = await wonQuery;

  let lostQuery = supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "lost");
  if (locationId) lostQuery = lostQuery.eq("location_id", locationId);
  const { count: lostCount } = await lostQuery;

  // Tasks due today — filter by lead_id if location is set
  const today = new Date().toISOString().split("T")[0];
  let tasksDueTodayQuery = supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .eq("due_date", today)
    .neq("status", "done");
  if (locationId && locationLeadIds && locationLeadIds.length > 0) {
    tasksDueTodayQuery = tasksDueTodayQuery.in("lead_id", locationLeadIds);
  } else if (locationId) {
    // No leads for this location, so 0 tasks
    tasksDueTodayQuery = tasksDueTodayQuery.eq("lead_id", "00000000-0000-0000-0000-000000000000");
  }
  const { count: tasksDueToday } = await tasksDueTodayQuery;

  // Tasks overdue
  let tasksOverdueQuery = supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .lt("due_date", today)
    .neq("status", "done");
  if (locationId && locationLeadIds && locationLeadIds.length > 0) {
    tasksOverdueQuery = tasksOverdueQuery.in("lead_id", locationLeadIds);
  } else if (locationId) {
    tasksOverdueQuery = tasksOverdueQuery.eq("lead_id", "00000000-0000-0000-0000-000000000000");
  }
  const { count: tasksOverdue } = await tasksOverdueQuery;

  // Recent activities — filter by lead_id if location is set
  let activitiesQuery = supabase
    .from("activities")
    .select("*, creator:users!activities_created_by_fkey(full_name), lead:leads!activities_lead_id_fkey(first_name, last_name)")
    .order("created_at", { ascending: false })
    .limit(10);
  if (locationId && locationLeadIds && locationLeadIds.length > 0) {
    activitiesQuery = activitiesQuery.in("lead_id", locationLeadIds);
  } else if (locationId) {
    activitiesQuery = activitiesQuery.eq("lead_id", "00000000-0000-0000-0000-000000000000");
  }
  const { data: recentActivities } = await activitiesQuery;

  // Recent notes — type='note', with lead name, last 20
  let notesQuery = supabase
    .from("activities")
    .select("id, lead_id, subject, created_at, lead:leads!activities_lead_id_fkey(first_name, last_name)")
    .eq("type", "note")
    .order("created_at", { ascending: false })
    .limit(20);
  if (locationId && locationLeadIds && locationLeadIds.length > 0) {
    notesQuery = notesQuery.in("lead_id", locationLeadIds);
  } else if (locationId) {
    notesQuery = notesQuery.eq("lead_id", "00000000-0000-0000-0000-000000000000");
  }
  const { data: recentNotes } = await notesQuery;

  // Pending follow-ups
  let followUpsQuery = supabase
    .from("activities")
    .select("*", { count: "exact", head: true })
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null);
  if (locationId && locationLeadIds && locationLeadIds.length > 0) {
    followUpsQuery = followUpsQuery.in("lead_id", locationLeadIds);
  } else if (locationId) {
    followUpsQuery = followUpsQuery.eq("lead_id", "00000000-0000-0000-0000-000000000000");
  }
  const { count: pendingFollowUps } = await followUpsQuery;

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
      recent_notes: recentNotes || [],
      conversion: { total_leads: total, won, lost, rate },
      pending_follow_ups: pendingFollowUps || 0,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Performance note: if you have many leads, create this RPC once in the Supabase SQL editor
 * to avoid fetching every lead row just to count by status:
 *
 *   create or replace function get_pipeline_counts(p_location_id uuid default null)
 *   returns table(status text, count bigint) language sql as $$
 *     select status, count(*) from leads
 *     where (p_location_id is null or location_id = p_location_id)
 *     group by status;
 *   $$;
 *
 * Then replace the pipelineQuery in Promise.all below with:
 *   supabase.rpc("get_pipeline_counts", { p_location_id: locationId ?? null })
 * and remove the pipelineCounts aggregation block at the bottom.
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const locationId = request.nextUrl.searchParams.get("location_id");
  const today = new Date().toISOString().split("T")[0];
  const NULL_ID = "00000000-0000-0000-0000-000000000000";

  if (locationId) {
    // When filtering by location, we need lead IDs to filter tasks/activities.
    // Parallelise the location-ID fetch with all lead aggregate queries so we
    // only pay one extra round-trip instead of one blocking sequential await.
    const [
      { data: pipelineData },
      { count: totalLeads },
      { count: wonCount },
      { count: lostCount },
      { data: locationLeads },
    ] = await Promise.all([
      supabase.from("leads").select("status").eq("location_id", locationId),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("location_id", locationId),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "won").eq("location_id", locationId),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "lost").eq("location_id", locationId),
      supabase.from("leads").select("id").eq("location_id", locationId),
    ]);

    const locationLeadIds = (locationLeads || []).map((l) => l.id);
    const hasLeads = locationLeadIds.length > 0;

    // Now fire tasks / activities / notes / followups in parallel using the fetched lead IDs
    let tasksDueTodayQ = supabase.from("tasks").select("*", { count: "exact", head: true }).eq("due_date", today).neq("status", "done");
    let tasksOverdueQ = supabase.from("tasks").select("*", { count: "exact", head: true }).lt("due_date", today).neq("status", "done");
    let activitiesQ = supabase.from("activities").select("*, creator:users!activities_created_by_fkey(full_name), lead:leads!activities_lead_id_fkey(first_name, last_name)").order("created_at", { ascending: false }).limit(10);
    let notesQ = supabase.from("activities").select("id, lead_id, subject, created_at, lead:leads!activities_lead_id_fkey(first_name, last_name)").eq("type", "note").order("created_at", { ascending: false }).limit(20);
    let followUpsQ = supabase.from("activities").select("*", { count: "exact", head: true }).eq("is_follow_up_done", false).not("follow_up_date", "is", null);

    if (hasLeads) {
      tasksDueTodayQ = tasksDueTodayQ.in("lead_id", locationLeadIds);
      tasksOverdueQ = tasksOverdueQ.in("lead_id", locationLeadIds);
      activitiesQ = activitiesQ.in("lead_id", locationLeadIds);
      notesQ = notesQ.in("lead_id", locationLeadIds);
      followUpsQ = followUpsQ.in("lead_id", locationLeadIds);
    } else {
      // Location has no leads — return empty counts without hitting indexes
      tasksDueTodayQ = tasksDueTodayQ.eq("lead_id", NULL_ID);
      tasksOverdueQ = tasksOverdueQ.eq("lead_id", NULL_ID);
      activitiesQ = activitiesQ.eq("lead_id", NULL_ID);
      notesQ = notesQ.eq("lead_id", NULL_ID);
      followUpsQ = followUpsQ.eq("lead_id", NULL_ID);
    }

    const [
      { count: tasksDueToday },
      { count: tasksOverdue },
      { data: recentActivities },
      { data: recentNotes },
      { count: pendingFollowUps },
    ] = await Promise.all([
      tasksDueTodayQ,
      tasksOverdueQ,
      activitiesQ,
      notesQ,
      followUpsQ,
    ]);

    const pipelineCounts: Record<string, number> = {};
    pipelineData?.forEach((l) => {
      pipelineCounts[l.status] = (pipelineCounts[l.status] || 0) + 1;
    });
    const pipeline = Object.entries(pipelineCounts).map(([status, count]) => ({ status, count }));

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

  // No location filter — fire all 9 queries in one parallel batch
  const [
    { data: pipelineData },
    { count: totalLeads },
    { count: wonCount },
    { count: lostCount },
    { count: tasksDueToday },
    { count: tasksOverdue },
    { data: recentActivities },
    { data: recentNotes },
    { count: pendingFollowUps },
  ] = await Promise.all([
    supabase.from("leads").select("status"),
    supabase.from("leads").select("*", { count: "exact", head: true }),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "won"),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "lost"),
    supabase.from("tasks").select("*", { count: "exact", head: true }).eq("due_date", today).neq("status", "done"),
    supabase.from("tasks").select("*", { count: "exact", head: true }).lt("due_date", today).neq("status", "done"),
    supabase.from("activities")
      .select("*, creator:users!activities_created_by_fkey(full_name), lead:leads!activities_lead_id_fkey(first_name, last_name)")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase.from("activities")
      .select("id, lead_id, subject, created_at, lead:leads!activities_lead_id_fkey(first_name, last_name)")
      .eq("type", "note")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("activities")
      .select("*", { count: "exact", head: true })
      .eq("is_follow_up_done", false)
      .not("follow_up_date", "is", null),
  ]);

  const pipelineCounts: Record<string, number> = {};
  pipelineData?.forEach((l) => {
    pipelineCounts[l.status] = (pipelineCounts[l.status] || 0) + 1;
  });
  const pipeline = Object.entries(pipelineCounts).map(([status, count]) => ({ status, count }));

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

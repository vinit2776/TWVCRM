import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch the DB user to determine role for data scoping
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const locationId = request.nextUrl.searchParams.get("location_id");
  const today = new Date().toISOString().split("T")[0];
  const NULL_ID = "00000000-0000-0000-0000-000000000000";

  // Conversion-rate cutoff. Pre-April-2026 leads were imported in bulk from
  // legacy systems and skew the won/total ratio against the team's actual
  // post-launch performance. Counting only leads created on/after this date
  // gives a fair "since launch" conversion rate. Bump the cutoff if the
  // team wants a tighter window later — kept as a single constant so the
  // three branches below stay consistent.
  const CONVERSION_CUTOFF = "2026-04-01";

  // ── Self-scoped path: sales_rep and floor_manager see only their own data ──
  // Filter all lead/task/activity queries to records assigned to this user.
  if (dbUser?.role === "sales_rep" || dbUser?.role === "floor_manager") {
    const { data: myLeads } = await supabase
      .from("leads")
      .select("id, status, created_at")
      .eq("assigned_to", dbUser.id);

    const myLeadIds = (myLeads ?? []).map((l) => l.id);
    const hasLeads = myLeadIds.length > 0;

    // Compute pipeline counts in-memory (list is small for a single user)
    const pipelineMap: Record<string, number> = {};
    for (const l of myLeads ?? []) {
      pipelineMap[l.status] = (pipelineMap[l.status] ?? 0) + 1;
    }
    const pipeline = Object.entries(pipelineMap).map(([status, count]) => ({ status, count }));

    // Conversion rate restricted to post-launch leads (see CONVERSION_CUTOFF
    // comment at top). Old imported data is excluded from the denominator.
    const cutoffLeads = (myLeads ?? []).filter((l) => l.created_at >= CONVERSION_CUTOFF);
    const total = cutoffLeads.length;
    const won = cutoffLeads.filter((l) => l.status === "won").length;
    const lost = cutoffLeads.filter((l) => l.status === "lost").length;
    const rate = total > 0 ? Math.round((won / total) * 100) : 0;

    let tasksDueTodayQ = supabase.from("tasks").select("*", { count: "exact", head: true }).eq("due_date", today).neq("status", "done");
    let tasksOverdueQ = supabase.from("tasks").select("*", { count: "exact", head: true }).lt("due_date", today).neq("status", "done");
    let activitiesQ = supabase.from("activities").select("*, creator:users!activities_created_by_fkey(full_name), lead:leads!activities_lead_id_fkey(first_name, last_name)").order("created_at", { ascending: false }).limit(10);
    let notesQ = supabase.from("activities").select("id, lead_id, subject, created_at, lead:leads!activities_lead_id_fkey(first_name, last_name)").eq("type", "note").order("created_at", { ascending: false }).limit(20);
    let followUpsQ = supabase.from("activities").select("*", { count: "exact", head: true }).eq("is_follow_up_done", false).not("follow_up_date", "is", null);

    if (hasLeads) {
      tasksDueTodayQ = tasksDueTodayQ.in("lead_id", myLeadIds);
      tasksOverdueQ = tasksOverdueQ.in("lead_id", myLeadIds);
      activitiesQ = activitiesQ.in("lead_id", myLeadIds);
      notesQ = notesQ.in("lead_id", myLeadIds);
      followUpsQ = followUpsQ.in("lead_id", myLeadIds);
    } else {
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
    ] = await Promise.all([tasksDueTodayQ, tasksOverdueQ, activitiesQ, notesQ, followUpsQ]);

    return NextResponse.json({
      data: {
        pipeline,
        tasks_due_today: tasksDueToday ?? 0,
        tasks_overdue: tasksOverdue ?? 0,
        recent_activities: recentActivities ?? [],
        recent_notes: recentNotes ?? [],
        conversion: { total_leads: total, won, lost, rate },
        pending_follow_ups: pendingFollowUps ?? 0,
      },
    });
  }
  // ── End self-scoped path ───────────────────────────────────────────────────

  if (locationId) {
    // When filtering by location, we need lead IDs to filter tasks/activities.
    // Parallelise the location-ID fetch with all lead aggregate queries so we
    // only pay one extra round-trip instead of one blocking sequential await.
    // The pipeline counts use a DB-side group-by function to avoid fetching every row.
    const [
      { data: pipelineData },
      { count: totalLeads },
      { count: wonCount },
      { count: lostCount },
      { data: locationLeads },
    ] = await Promise.all([
      supabase.rpc("get_pipeline_counts", { p_location_id: locationId }),
      // Conversion totals restricted to post-CONVERSION_CUTOFF leads to keep the
      // KPI honest after the legacy bulk import. Pipeline still reflects the
      // entire pool — that's a "where does my pipeline sit right now" view,
      // not a performance metric.
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("location_id", locationId).gte("created_at", CONVERSION_CUTOFF),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "won").eq("location_id", locationId).gte("created_at", CONVERSION_CUTOFF),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "lost").eq("location_id", locationId).gte("created_at", CONVERSION_CUTOFF),
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

    // RPC already returns [{status, count}] — no JS aggregation needed
    const pipeline = (pipelineData || []) as { status: string; count: number }[];

    const total = totalLeads || 0;
    const won = wonCount || 0;
    const lost = lostCount || 0;
    const rate = total > 0 ? Math.round((won / total) * 100) : 0;

    return NextResponse.json({
      data: {
        pipeline,
        tasks_due_today: tasksDueToday || 0,
        tasks_overdue: tasksOverdue || 0,
        recent_activities: recentActivities || [],
        recent_notes: recentNotes || [],
        conversion: { total_leads: total, won, lost, rate },
        pending_follow_ups: pendingFollowUps || 0,
      },
    });
  }

  // No location filter — fire all queries in one parallel batch.
  // Pipeline uses a DB-side group-by RPC to avoid fetching every lead row.
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
    supabase.rpc("get_pipeline_counts", { p_location_id: null }),
    // Conversion totals restricted to post-CONVERSION_CUTOFF leads to ignore
    // the legacy bulk-imported pre-April-2026 records that were skewing the
    // ratio. Pipeline view above still reflects the full pool.
    supabase.from("leads").select("*", { count: "exact", head: true }).gte("created_at", CONVERSION_CUTOFF),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "won").gte("created_at", CONVERSION_CUTOFF),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "lost").gte("created_at", CONVERSION_CUTOFF),
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

  // RPC already returns [{status, count}] — no JS aggregation needed
  const pipeline = (pipelineData || []) as { status: string; count: number }[];

  const total = totalLeads || 0;
  const won = wonCount || 0;
  const lost = lostCount || 0;
  const rate = total > 0 ? Math.round((won / total) * 100) : 0;

  return NextResponse.json({
    data: {
      pipeline,
      tasks_due_today: tasksDueToday || 0,
      tasks_overdue: tasksOverdue || 0,
      recent_activities: recentActivities || [],
      recent_notes: recentNotes || [],
      conversion: { total_leads: total, won, lost, rate },
      pending_follow_ups: pendingFollowUps || 0,
    },
  });
}

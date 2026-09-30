import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getDashboardAuth } from "@/lib/dashboard-auth";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { user, dbUser } = await getDashboardAuth();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  // Start-of-current-month cutoff for the secondary cohort metric:
  // "of the leads created this month, how many have converted (won) so far?"
  // Gives a real-time pulse alongside the cumulative since-launch number.
  // Computed in the server's clock — for an India-hosted ops team running on
  // IST this is fine; the date drift only matters around midnight on the 1st.
  const now = new Date();
  const MONTH_CUTOFF = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

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

    // This-month cohort: of leads created this month, how many converted
    // (regardless of when the conversion happened — usually within days).
    const monthLeads = (myLeads ?? []).filter((l) => l.created_at >= MONTH_CUTOFF);
    const monthTotal = monthLeads.length;
    const monthWon = monthLeads.filter((l) => l.status === "won").length;
    const monthRate = monthTotal > 0 ? Math.round((monthWon / monthTotal) * 100) : 0;

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
        conversion: {
          total_leads: total, won, lost, rate,
          this_month: { total: monthTotal, won: monthWon, rate: monthRate },
        },
        pending_follow_ups: pendingFollowUps ?? 0,
      },
    });
  }
  // ── End self-scoped path ───────────────────────────────────────────────────

  if (locationId) {
    // When filtering by location, we need lead IDs to filter tasks/activities.
    // Parallelise the location-ID fetch with all lead aggregate queries so we
    // only pay one extra round-trip instead of one blocking sequential await.
    // Pipeline is computed in JS from the leads fetch (avoids RPC dependency).
    const [
      { data: allLocationLeads },
      { count: totalLeads },
      { count: wonCount },
      { count: lostCount },
      { count: monthTotalCount },
      { count: monthWonCount },
    ] = await Promise.all([
      // range(0,9999) bypasses the PostgREST 1 000-row default cap
      supabase.from("leads").select("id, status").eq("location_id", locationId).range(0, 9999),
      // Conversion totals restricted to post-CONVERSION_CUTOFF leads to keep the
      // KPI honest after the legacy bulk import. Pipeline still reflects the
      // entire pool — that's a "where does my pipeline sit right now" view,
      // not a performance metric.
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("location_id", locationId).gte("created_at", CONVERSION_CUTOFF),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "won").eq("location_id", locationId).gte("created_at", CONVERSION_CUTOFF),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "lost").eq("location_id", locationId).gte("created_at", CONVERSION_CUTOFF),
      // This-month cohort: leads created this month + how many of those won
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("location_id", locationId).gte("created_at", MONTH_CUTOFF),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("location_id", locationId).eq("status", "won").gte("created_at", MONTH_CUTOFF),
    ]);

    // Build pipeline from the fetched lead rows (same pattern as self-scoped path)
    const pipelineMap: Record<string, number> = {};
    for (const l of allLocationLeads ?? []) {
      pipelineMap[l.status] = (pipelineMap[l.status] ?? 0) + 1;
    }
    const locationLeadIds = (allLocationLeads || []).map((l) => l.id);
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

    const pipeline = Object.entries(pipelineMap).map(([status, count]) => ({ status, count }));

    const total = totalLeads || 0;
    const won = wonCount || 0;
    const lost = lostCount || 0;
    const rate = total > 0 ? Math.round((won / total) * 100) : 0;
    const monthTotal = monthTotalCount || 0;
    const monthWon = monthWonCount || 0;
    const monthRate = monthTotal > 0 ? Math.round((monthWon / monthTotal) * 100) : 0;

    return NextResponse.json({
      data: {
        pipeline,
        tasks_due_today: tasksDueToday || 0,
        tasks_overdue: tasksOverdue || 0,
        recent_activities: recentActivities || [],
        recent_notes: recentNotes || [],
        conversion: {
          total_leads: total, won, lost, rate,
          this_month: { total: monthTotal, won: monthWon, rate: monthRate },
        },
        pending_follow_ups: pendingFollowUps || 0,
      },
    });
  }

  // No location filter — fire all queries in one parallel batch.
  // Pipeline is computed in JS from lead statuses (avoids RPC dependency).
  const [
    { data: allLeads },
    { count: totalLeads },
    { count: wonCount },
    { count: lostCount },
    { count: tasksDueToday },
    { count: tasksOverdue },
    { data: recentActivities },
    { data: recentNotes },
    { count: pendingFollowUps },
    { count: monthTotalCount },
    { count: monthWonCount },
  ] = await Promise.all([
    // PostgREST default row cap is 1 000. With 1 500+ leads the unranged query
    // silently truncates, making pipelineTotal wrong. Fetch all rows explicitly.
    supabase.from("leads").select("status").range(0, 9999),
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
    // This-month cohort: leads created since the 1st of this month + how
    // many of those have won so far. Real-time pulse alongside the
    // since-launch cumulative number.
    supabase.from("leads").select("*", { count: "exact", head: true }).gte("created_at", MONTH_CUTOFF),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "won").gte("created_at", MONTH_CUTOFF),
  ]);

  // Group lead statuses in JS (avoids RPC dependency)
  const globalPipelineMap: Record<string, number> = {};
  for (const l of allLeads ?? []) {
    globalPipelineMap[l.status] = (globalPipelineMap[l.status] ?? 0) + 1;
  }
  const pipeline = Object.entries(globalPipelineMap).map(([status, count]) => ({ status, count }));

  const total = totalLeads || 0;
  const won = wonCount || 0;
  const lost = lostCount || 0;
  const rate = total > 0 ? Math.round((won / total) * 100) : 0;
  const monthTotal = monthTotalCount || 0;
  const monthWon = monthWonCount || 0;
  const monthRate = monthTotal > 0 ? Math.round((monthWon / monthTotal) * 100) : 0;

  return NextResponse.json({
    data: {
      pipeline,
      tasks_due_today: tasksDueToday || 0,
      tasks_overdue: tasksOverdue || 0,
      recent_activities: recentActivities || [],
      recent_notes: recentNotes || [],
      conversion: {
        total_leads: total, won, lost, rate,
        this_month: { total: monthTotal, won: monthWon, rate: monthRate },
      },
      pending_follow_ups: pendingFollowUps || 0,
    },
  });
}

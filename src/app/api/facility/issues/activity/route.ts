import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const FEED_EVENT_TYPES = ["claimed", "assigned", "resolved", "reopened", "status_changed"];
const OPEN_STATUSES = ["new", "acknowledged", "in_progress", "reopened"];
const HOUR_MS = 3_600_000;
const FEED_LIMIT = 15;

interface IssueSnapshot {
  issue_number: string;
  title: string;
  task_type: string;
  status: string;
  scope: string;
  priority: string;
  reported_at: string | null;
  resolved_at: string | null;
  sla_target_at: string | null;
  location: { name: string } | null;
  assignee: { full_name: string } | null;
}

interface EventRow {
  id: string;
  issue_id: string;
  event_type: string;
  actor_label: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  issue: IssueSnapshot | null;
}

/**
 * GET /api/facility/issues/activity
 * Powers the Tasks / Work Orders overview: a "needs attention" roll-up, one
 * feed row per ticket (not per event), and a weekly summary.
 *
 * Feed rows: ownership/completion events only (claims, assignments,
 * resolutions, reopens, closes). Collaborator adds are logged as "assigned"
 * events but are folded into a count on the ticket's row instead of getting
 * rows of their own. "closed" has no event_type of its own (it is a
 * status_changed with payload.to === "closed"), so it is filtered below.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();

  const [eventsRes, overdueRes, dueSoonRes, unclaimedRes, criticalRes, weekResolvedRes, weekReopenedRes] = await Promise.all([
    supabase
      .from("facility_issue_events")
      .select("id, issue_id, event_type, actor_label, message, payload, created_at, issue:facility_issues!facility_issue_events_issue_id_fkey(issue_number, title, task_type, status, scope, priority, reported_at, resolved_at, sla_target_at, location:locations(name), assignee:users!facility_issues_assigned_to_fkey(full_name))")
      .in("event_type", FEED_EVENT_TYPES)
      .order("created_at", { ascending: false })
      .limit(150),
    supabase.from("facility_issues").select("issue_number, sla_target_at").in("status", OPEN_STATUSES)
      .lt("sla_target_at", iso(now)).order("sla_target_at", { ascending: true }).limit(100),
    supabase.from("facility_issues").select("id", { count: "exact", head: true }).in("status", OPEN_STATUSES)
      .gte("sla_target_at", iso(now)).lte("sla_target_at", iso(now + 4 * HOUR_MS)),
    supabase.from("facility_issues").select("id", { count: "exact", head: true }).in("status", ["new", "reopened"])
      .is("assigned_to", null).lt("reported_at", iso(now - 6 * HOUR_MS)),
    supabase.from("facility_issues").select("id", { count: "exact", head: true }).in("status", OPEN_STATUSES).eq("priority", "critical"),
    supabase.from("facility_issues").select("reported_at, resolved_at, sla_target_at, assignee:users!facility_issues_assigned_to_fkey(full_name)")
      .gte("resolved_at", iso(now - 7 * 24 * HOUR_MS)).limit(500),
    supabase.from("facility_issue_events").select("issue_id").eq("event_type", "reopened").gte("created_at", iso(now - 7 * 24 * HOUR_MS)).limit(500),
  ]);

  if (eventsRes.error) return NextResponse.json({ error: eventsRes.error.message }, { status: 500 });

  // One row per ticket, newest meaningful event wins; collaborator adds only count.
  const rows = new Map<string, {
    id: string; issue_id: string; event_type: string; actor_label: string | null;
    message: string | null; payload: Record<string, unknown> | null; created_at: string;
    issue: IssueSnapshot | null; collaborators_added: number;
  }>();
  const collaboratorCounts = new Map<string, number>();
  const events = (eventsRes.data ?? []) as unknown as EventRow[];

  for (const e of events) {
    const added = e.payload?.collaborators_added;
    if (Array.isArray(added)) {
      collaboratorCounts.set(e.issue_id, (collaboratorCounts.get(e.issue_id) ?? 0) + added.length);
      continue;
    }
    if (e.event_type === "status_changed" && e.payload?.to !== "closed") continue;
    if (!rows.has(e.issue_id)) rows.set(e.issue_id, { ...e, collaborators_added: 0 });
  }
  const feed = [...rows.values()]
    .map((r) => ({ ...r, collaborators_added: collaboratorCounts.get(r.issue_id) ?? 0 }))
    .slice(0, FEED_LIMIT);

  const overdue = overdueRes.data ?? [];
  const oldest = overdue[0];
  const resolved = weekResolvedRes.data ?? [];
  const onTime = resolved.filter((r) => r.resolved_at && r.sla_target_at && new Date(r.resolved_at) <= new Date(r.sla_target_at)).length;
  const durations = resolved
    .filter((r) => r.resolved_at && r.reported_at)
    .map((r) => new Date(r.resolved_at as string).getTime() - new Date(r.reported_at as string).getTime());
  const byPerson = new Map<string, number>();
  for (const r of resolved) {
    const name = (r.assignee as unknown as { full_name: string } | null)?.full_name;
    if (name) byPerson.set(name, (byPerson.get(name) ?? 0) + 1);
  }
  const busiest = [...byPerson.entries()].sort((a, b) => b[1] - a[1])[0];

  return NextResponse.json({
    data: feed,
    attention: {
      overdue: overdue.length,
      oldest_overdue: oldest ? { issue_number: oldest.issue_number, hours: Math.round((now - new Date(oldest.sla_target_at as string).getTime()) / HOUR_MS) } : null,
      due_soon: dueSoonRes.count ?? 0,
      unclaimed: unclaimedRes.count ?? 0,
      critical: criticalRes.count ?? 0,
      reopened_week: new Set((weekReopenedRes.data ?? []).map((r) => r.issue_id)).size,
    },
    weekly: {
      resolved: resolved.length,
      on_time: onTime,
      avg_hours: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length / HOUR_MS) * 10) / 10 : null,
      busiest: busiest ? { name: busiest[0], count: busiest[1] } : null,
    },
  });
}

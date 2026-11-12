import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { asString, type DashRow } from "@/lib/dashboard-query";
import { FACILITY_OPEN_STATUSES, normaliseScope, type FacilityWidgetItem } from "@/lib/facility-widget";

export const maxDuration = 30;

/**
 * GET /api/dashboard/facility?location_id=<uuid>
 *   → every open facility issue (tickets and delegated tasks) plus those
 *     resolved or closed in the last 7 days, in a compact shape. The widget
 *     derives SLA state, lanes, ageing and the next-7-days strip from
 *     sla_target_at on the client, so the counts and the list always agree.
 * GET ...&view=timeline&issue_id=<uuid>
 *   → that issue's event timeline.
 *
 * Read-only. Access: admin, fms.
 */

const PAGE = 1000;
const RECENT_DAYS = 7;
const TIMELINE_LIMIT = 40;

const SELECT =
  "id, issue_number, title, scope, priority, status, task_type, reported_at, resolved_at, sla_target_at, updated_at, " +
  "location:locations(id, name), assignee:users!facility_issues_assigned_to_fkey(id, full_name)";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await createAdminClient();
  const { data: dbUser } = await admin.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "fms"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const locationId = sp.get("location_id");

  try {
    if (sp.get("view") === "timeline") {
      const issueId = sp.get("issue_id");
      if (!issueId) return NextResponse.json({ error: "issue_id required" }, { status: 400 });
      const { data, error } = await admin
        .from("facility_issue_events")
        .select("id, event_type, actor_label, message, created_at")
        .eq("issue_id", issueId)
        .order("created_at", { ascending: true })
        .limit(TIMELINE_LIMIT);
      if (error) throw new Error(error.message);
      return NextResponse.json({ data: { events: data ?? [] } });
    }

    const nowMs = Date.now();
    const since = new Date(nowMs - RECENT_DAYS * 86_400_000).toISOString();
    const rows: DashRow[] = [];

    // Open issues (no date bound — an old open issue is exactly what matters)
    // and the recently closed ones, paged past PostgREST's 1000-row cap.
    for (const closedBranch of [false, true]) {
      for (let from = 0; ; from += PAGE) {
        let q = admin.from("facility_issues").select(SELECT).order("id").range(from, from + PAGE - 1);
        q = closedBranch
          ? q.in("status", ["resolved", "closed"]).gte("resolved_at", since)
          : q.in("status", [...FACILITY_OPEN_STATUSES]);
        if (locationId) q = q.eq("location_id", locationId);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        rows.push(...((data ?? []) as unknown as DashRow[]));
        if (!data || data.length < PAGE) break;
      }
    }

    const items: FacilityWidgetItem[] = rows.map((r) => {
      const loc = r.location as { name?: string } | null;
      const who = r.assignee as { full_name?: string } | null;
      const reported = asString(r.reported_at) ?? new Date(nowMs).toISOString();
      const updated = asString(r.updated_at) ?? reported;
      const resolved = asString(r.resolved_at);
      return {
        id: r.id as string,
        number: asString(r.issue_number) ?? "—",
        title: asString(r.title) ?? "Untitled",
        scope: normaliseScope(asString(r.scope)),
        priority: asString(r.priority) ?? "medium",
        status: asString(r.status) ?? "new",
        kind: r.task_type === "delegated_task" ? "task" : "ticket",
        location: loc?.name ?? null,
        assignee: who?.full_name ?? null,
        reported_at: reported,
        last_activity: resolved && resolved > updated ? resolved : updated,
        resolved_at: resolved,
        sla_target_at: asString(r.sla_target_at),
      };
    });

    return NextResponse.json({ data: { now: new Date(nowMs).toISOString(), items } });
  } catch (err) {
    // Message only — tickets can name people and rooms, never log them.
    console.error("[dashboard/facility]", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Failed to load facility data" }, { status: 500 });
  }
}

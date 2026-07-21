import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const OWNERSHIP_AND_COMPLETION_TYPES = ["claimed", "assigned", "resolved", "reopened", "status_changed"];

/**
 * GET /api/facility/issues/activity
 * Last 20 "who did what, when" events across all tickets — claims,
 * assignments/take-overs, resolutions, reopens, and closes. Deliberately
 * excludes comments and routine status ticks (e.g. acknowledged→in_progress)
 * to stay signal-dense; "closed" has no dedicated event_type (it's logged as
 * status_changed with payload.to === "closed"), so that's filtered client-side
 * below rather than in the query.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("facility_issue_events")
    .select("id, issue_id, event_type, actor_label, message, payload, created_at, issue:facility_issues!facility_issue_events_issue_id_fkey(issue_number, title, task_type, status)")
    .in("event_type", OWNERSHIP_AND_COMPLETION_TYPES)
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const filtered = (data ?? []).filter((row) => {
    if (row.event_type !== "status_changed") return true;
    const payload = row.payload as { to?: string } | null;
    return payload?.to === "closed";
  }).slice(0, 20);

  return NextResponse.json({ data: filtered });
}

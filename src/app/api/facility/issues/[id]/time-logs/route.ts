import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";

/**
 * GET /api/facility/issues/[id]/time-logs
 * Returns { data: entries[], total_minutes } for this issue, newest first.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("facility_issue_time_logs")
    .select("id, minutes, note, logged_at, logger:users!facility_issue_time_logs_logged_by_fkey(id, full_name)")
    .eq("issue_id", id)
    .order("logged_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const totalMinutes = (data || []).reduce((sum, r) => sum + (r.minutes as number), 0);
  return NextResponse.json({ data: data || [], total_minutes: totalMinutes });
}

/**
 * POST /api/facility/issues/[id]/time-logs
 * Body: { minutes: number, note?: string, logged_at?: string }
 * Same role gate as PUT /api/facility/issues/[id] (anyone who can work the
 * ticket) — not restricted to the current assignee, so collaborators and
 * past assignees can log time for work they already did.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.workOnIssues)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const body = await request.json();
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return NextResponse.json({ error: "minutes must be a positive number" }, { status: 400 });
  }

  const { data: issue } = await supabase
    .from("facility_issues").select("id").eq("id", id).single();
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("facility_issue_time_logs")
    .insert({
      issue_id: id,
      logged_by: dbUser!.id,
      minutes: Math.round(minutes),
      note: body.note?.trim() || null,
      logged_at: body.logged_at || new Date().toISOString(),
    })
    .select("id, minutes, note, logged_at, logger:users!facility_issue_time_logs_logged_by_fkey(id, full_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data }, { status: 201 });
}

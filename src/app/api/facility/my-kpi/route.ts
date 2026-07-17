import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/facility/my-kpi
 * Personal KPI score for the current user — Work Orders + Tasks combined
 * (both live in facility_issues, distinguished only by task_type). Private
 * by design: this endpoint only ever returns the caller's own numbers.
 *
 * Reads facility_issue_kpi_credits rather than filtering facility_issues by
 * assigned_to directly, so department-roster members who collaborated on a
 * ticket (role 'member', weighted below the primary assignee) are counted
 * alongside tickets the user was the primary assignee on (role 'primary').
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: rows, error } = await supabase
    .from("facility_issue_kpi_credits")
    .select("role, points, issue:facility_issues!facility_issue_kpi_credits_issue_id_fkey(resolved_at)")
    .eq("user_id", dbUser.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  let totalPoints = 0;
  let monthPoints = 0;
  let ticketsScored = 0;
  let monthTicketsScored = 0;

  for (const row of rows ?? []) {
    const points = Number(row.points) || 0;
    const resolvedAt = (row.issue as unknown as { resolved_at: string | null } | null)?.resolved_at;
    totalPoints += points;
    ticketsScored += 1;
    if (resolvedAt && new Date(resolvedAt) >= monthStart) {
      monthPoints += points;
      monthTicketsScored += 1;
    }
  }

  return NextResponse.json({
    data: {
      total_points: totalPoints,
      tickets_scored: ticketsScored,
      month_points: monthPoints,
      month_tickets_scored: monthTicketsScored,
      avg_points: ticketsScored > 0 ? Math.round((totalPoints / ticketsScored) * 10) / 10 : 0,
    },
  });
}

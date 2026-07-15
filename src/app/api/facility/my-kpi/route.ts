import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/facility/my-kpi
 * Personal KPI score for the current user — Work Orders + Tasks combined
 * (both live in facility_issues, distinguished only by task_type). Private
 * by design: this endpoint only ever returns the caller's own numbers.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: rows, error } = await supabase
    .from("facility_issues")
    .select("kpi_points, resolved_at, task_type")
    .eq("assigned_to", dbUser.id)
    .not("kpi_points", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  let totalPoints = 0;
  let monthPoints = 0;
  let ticketsScored = 0;
  let monthTicketsScored = 0;

  for (const row of rows ?? []) {
    const points = Number(row.kpi_points) || 0;
    totalPoints += points;
    ticketsScored += 1;
    if (row.resolved_at && new Date(row.resolved_at) >= monthStart) {
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

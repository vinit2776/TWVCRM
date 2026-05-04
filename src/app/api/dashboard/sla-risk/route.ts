import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/sla-risk?location_id=<uuid>
 * Returns open support tickets and facility issues bucketed by priority and
 * age (>SLA target). SLA targets used (working assumption):
 *   critical: 4h, high: 24h, medium: 72h, low: 7d.
 *
 * Access: admin, manager, fms, it_manager, it_technician, office_admin.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const allowed = ["admin", "manager", "fms", "it_manager", "it_technician", "office_admin"];
  if (!dbUser || !allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");

  // SLA in hours per priority
  const SLA_HOURS: Record<string, number> = {
    critical: 4,
    high: 24,
    medium: 72,
    low: 24 * 7,
  };

  // Support tickets — open / in_progress
  const ticketsQ = adminSupabase
    .from("support_tickets")
    .select("id, priority, status, created_at")
    .in("status", ["open", "in_progress", "build_approved"]);

  // Facility issues — exclude resolved/closed
  let issuesQ = adminSupabase
    .from("facility_issues")
    .select("id, priority, status, created_at, location_id")
    .in("status", ["new", "acknowledged", "in_progress", "reopened"]);

  if (locationId) {
    issuesQ = issuesQ.eq("location_id", locationId);
  }

  const [{ data: tickets }, { data: issues }] = await Promise.all([ticketsQ, issuesQ]);

  type Row = { priority: string; created_at: string };

  const now = Date.now();
  function bucket(rows: Row[]) {
    const byPriority: Record<string, { open: number; breached: number }> = {
      critical: { open: 0, breached: 0 },
      high: { open: 0, breached: 0 },
      medium: { open: 0, breached: 0 },
      low: { open: 0, breached: 0 },
    };
    for (const r of rows) {
      const p = (r.priority ?? "medium").toLowerCase();
      const slaHours = SLA_HOURS[p] ?? 72;
      const ageHours = (now - new Date(r.created_at).getTime()) / 3_600_000;
      if (!byPriority[p]) byPriority[p] = { open: 0, breached: 0 };
      byPriority[p].open += 1;
      if (ageHours > slaHours) byPriority[p].breached += 1;
    }
    return byPriority;
  }

  const ticketBuckets = bucket((tickets ?? []) as Row[]);
  const issueBuckets = bucket((issues ?? []) as Row[]);

  const sumOpen = (b: Record<string, { open: number; breached: number }>) =>
    Object.values(b).reduce((s, v) => s + v.open, 0);
  const sumBreached = (b: Record<string, { open: number; breached: number }>) =>
    Object.values(b).reduce((s, v) => s + v.breached, 0);

  return NextResponse.json({
    data: {
      tickets: {
        total_open: sumOpen(ticketBuckets),
        total_breached: sumBreached(ticketBuckets),
        by_priority: ticketBuckets,
      },
      issues: {
        total_open: sumOpen(issueBuckets),
        total_breached: sumBreached(issueBuckets),
        by_priority: issueBuckets,
      },
    },
  });
}

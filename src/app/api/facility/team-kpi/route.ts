import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { FacilityTechnicianKpi } from "@/types";

/**
 * GET /api/facility/team-kpi
 * Query: ?date_from&date_to&scope&format=csv
 *
 * Aggregates per-technician metrics for appraisal / management review.
 *   - assigned, resolved
 *   - avg_ack_minutes, avg_resolution_minutes
 *   - sla_compliance_pct (headline metric)
 *   - reopen_rate_pct
 *   - avg_satisfaction
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope");
  const format = searchParams.get("format");

  const now = new Date();
  const dateFrom = searchParams.get("date_from") ?? new Date(now.getTime() - 30 * 86400000).toISOString();
  const dateTo = searchParams.get("date_to") ?? now.toISOString();

  // 1) Pull all IT technicians + IT managers (assignable users)
  const { data: techs, error: tErr } = await supabase
    .from("users")
    .select("id, full_name, role, is_active")
    .in("role", ["it_technician", "it_manager"])
    .eq("is_active", true);
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

  // 2) Pull issues for the period
  let issuesQ = supabase
    .from("facility_issues")
    .select(`
      id, status, priority, scope,
      reported_at, acknowledged_at, resolved_at,
      sla_target_at, sla_breached, reopen_count,
      satisfaction_rating, assigned_to
    `)
    .gte("created_at", dateFrom)
    .lte("created_at", dateTo);
  if (scope) issuesQ = issuesQ.eq("scope", scope);

  const { data: issues, error: iErr } = await issuesQ;
  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });

  type IssueRow = {
    id: string; status: string; assigned_to: string | null;
    acknowledged_at: string | null; resolved_at: string | null; reported_at: string;
    sla_target_at: string | null; sla_breached: boolean;
    reopen_count: number; satisfaction_rating: number | null;
  };

  const byTech = new Map<string, IssueRow[]>();
  for (const i of (issues ?? []) as IssueRow[]) {
    if (!i.assigned_to) continue;
    const arr = byTech.get(i.assigned_to) ?? [];
    arr.push(i);
    byTech.set(i.assigned_to, arr);
  }

  const rows: FacilityTechnicianKpi[] = (techs ?? []).map((t) => {
    const list = byTech.get(t.id) ?? [];
    const resolved = list.filter((i) => i.status === "resolved" || i.status === "closed");

    const ackTimes = list
      .filter((i) => i.acknowledged_at)
      .map((i) => (new Date(i.acknowledged_at!).getTime() - new Date(i.reported_at).getTime()) / 60000)
      .filter((n) => isFinite(n) && n >= 0);
    const avgAck = ackTimes.length ? Math.round(ackTimes.reduce((a, b) => a + b, 0) / ackTimes.length) : 0;

    const resTimes = resolved
      .filter((i) => i.acknowledged_at && i.resolved_at)
      .map((i) => (new Date(i.resolved_at!).getTime() - new Date(i.acknowledged_at!).getTime()) / 60000)
      .filter((n) => isFinite(n) && n >= 0);
    const avgRes = resTimes.length ? Math.round(resTimes.reduce((a, b) => a + b, 0) / resTimes.length) : 0;

    const slaEligible = resolved.filter((i) => i.sla_target_at);
    const slaPct = slaEligible.length === 0
      ? 100
      : Math.round((slaEligible.filter((i) => !i.sla_breached).length / slaEligible.length) * 1000) / 10;

    const reopens = list.filter((i) => (i.reopen_count ?? 0) > 0).length;
    const reopenPct = list.length === 0 ? 0 : Math.round((reopens / list.length) * 1000) / 10;

    const sats = resolved.map((i) => i.satisfaction_rating).filter((s): s is number => typeof s === "number");
    const avgSat = sats.length === 0 ? null : Math.round((sats.reduce((a, b) => a + b, 0) / sats.length) * 10) / 10;

    return {
      technician_id: t.id,
      technician_name: t.full_name,
      assigned: list.length,
      resolved: resolved.length,
      avg_ack_minutes: avgAck,
      avg_resolution_minutes: avgRes,
      sla_compliance_pct: slaPct,
      reopen_rate_pct: reopenPct,
      avg_satisfaction: avgSat,
      satisfaction_responses: sats.length,
    };
  });

  // CSV export
  if (format === "csv") {
    const header = [
      "Technician", "Assigned", "Resolved", "Avg Ack (min)", "Avg Resolution (min)",
      "SLA Compliance %", "Reopen Rate %", "Avg Satisfaction", "Satisfaction Responses",
    ].join(",");
    const lines = rows.map((r) =>
      [
        `"${r.technician_name.replace(/"/g, '""')}"`,
        r.assigned, r.resolved, r.avg_ack_minutes, r.avg_resolution_minutes,
        r.sla_compliance_pct, r.reopen_rate_pct,
        r.avg_satisfaction ?? "", r.satisfaction_responses,
      ].join(",")
    );
    const csv = [header, ...lines].join("\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="facility-team-kpi-${dateFrom.slice(0,10)}-${dateTo.slice(0,10)}.csv"`,
      },
    });
  }

  return NextResponse.json({ data: rows, period: { from: dateFrom, to: dateTo } });
}

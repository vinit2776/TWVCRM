import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES, logIssueEvent } from "@/lib/facility";
import { computeKpiPoints } from "@/lib/facility-kpi";
import type { FacilityIssuePriority } from "@/types";

/**
 * PATCH /api/facility/issues/[id]/extend/[extId]/pass-card
 * Override-tier only. Flips (or confirms) whether an extension is KPI-exempt,
 * independent of its reason category — the escape hatch for edge cases the
 * category picker doesn't fit, or to correct a mis-tagged reason. If the
 * ticket has already been scored, recomputes kpi_points so the override
 * takes effect immediately rather than silently on the next resolve.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; extId: string }> }
) {
  const { id, extId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, full_name, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.passCard)) {
    return NextResponse.json({ error: "Admin or manager access required" }, { status: 403 });
  }

  const body = await request.json();
  if (typeof body.kpi_exempt !== "boolean") {
    return NextResponse.json({ error: "kpi_exempt (boolean) is required" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() : null;

  const { data: extension, error: loadErr } = await supabase
    .from("facility_issue_tat_extensions")
    .select("id, issue_id, kpi_exempt")
    .eq("id", extId).eq("issue_id", id).single();
  if (loadErr || !extension) return NextResponse.json({ error: "Extension not found" }, { status: 404 });

  const { data: updatedExt, error } = await supabase
    .from("facility_issue_tat_extensions")
    .update({
      kpi_exempt: body.kpi_exempt,
      pass_card_by: dbUser!.id,
      pass_card_at: new Date().toISOString(),
      pass_card_note: note,
    })
    .eq("id", extId)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If this is the most recent extension on an already-scored ticket, recompute.
  const { data: issue } = await supabase
    .from("facility_issues")
    .select("id, priority, sla_breached, reopen_count, satisfaction_rating, kpi_points, status")
    .eq("id", id).single();

  if (issue && issue.kpi_points != null && (issue.status === "resolved" || issue.status === "closed")) {
    const { data: latestExt } = await supabase
      .from("facility_issue_tat_extensions")
      .select("kpi_exempt")
      .eq("issue_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const kpiResult = computeKpiPoints({
      priority: issue.priority as FacilityIssuePriority,
      slaBreached: issue.sla_breached ?? false,
      reopenCount: issue.reopen_count ?? 0,
      satisfactionRating: issue.satisfaction_rating,
      latestExtensionExempt: latestExt?.kpi_exempt ?? null,
    });
    await supabase.from("facility_issues").update({ kpi_points: kpiResult.total, kpi_breakdown: kpiResult.lines }).eq("id", id);
  }

  await logIssueEvent(supabase, {
    issueId: id,
    eventType: "pass_card",
    actorId: dbUser!.id,
    actorLabel: dbUser!.full_name,
    message: `Pass card: extension marked ${body.kpi_exempt ? "KPI-exempt" : "counts against KPI"}${note ? ` — ${note}` : ""}`,
    payload: { extension_id: extId, kpi_exempt: body.kpi_exempt },
  });

  logAudit(supabase, {
    entityType: "facility_issue",
    entityId: id,
    action: "update",
    performedBy: dbUser!.id,
    changes: { extension_kpi_exempt: { old: extension.kpi_exempt, new: body.kpi_exempt } },
  });

  return NextResponse.json({ data: updatedExt });
}

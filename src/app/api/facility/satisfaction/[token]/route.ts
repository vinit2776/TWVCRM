import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { logIssueEvent } from "@/lib/facility";
import { computeKpiPoints, writeKpiCredits } from "@/lib/facility-kpi";
import { notifyIssueAssignee } from "@/lib/facility-notifications";
import type { FacilityIssuePriority } from "@/types";

/**
 * Public endpoint — keyed by satisfaction_token, NO auth required.
 * Uses the service-role client because the table RLS only permits authenticated
 * reads. Token uniqueness + length is the only guard; rotate via UPDATE if leaked.
 *
 * GET  → returns { issue_number, title, status, location_name, resolved_at, already_rated }
 * POST → body: { rating: 1..5, comment? } — saves rating and (if low) auto-reopens.
 */

async function loadByToken(supabase: ReturnType<typeof createAdminClient>, token: string) {
  return supabase
    .from("facility_issues")
    .select(`
      id, issue_number, title, status, resolved_at, satisfaction_rating, satisfaction_received_at,
      reopen_count, satisfaction_token, priority, sla_breached, scope, assigned_to, category_id,
      location:locations(id, name)
    `)
    .eq("satisfaction_token", token)
    .single();
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data, error } = await loadByToken(supabase, token);
  if (error || !data) return NextResponse.json({ error: "Invalid link" }, { status: 404 });

  return NextResponse.json({
    data: {
      issue_number: data.issue_number,
      title: data.title,
      status: data.status,
      resolved_at: data.resolved_at,
      location_name: (data.location as { name?: string } | null)?.name ?? null,
      already_rated: !!data.satisfaction_received_at,
      current_rating: data.satisfaction_rating,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: issue, error } = await loadByToken(supabase, token);
  if (error || !issue) return NextResponse.json({ error: "Invalid link" }, { status: 404 });

  const body = await request.json();
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "Rating must be 1-5" }, { status: 400 });
  }
  const comment = body.comment ? String(body.comment).slice(0, 2000) : null;

  // Update rating
  const updates: Record<string, unknown> = {
    satisfaction_rating: rating,
    satisfaction_comment: comment,
    satisfaction_received_at: new Date().toISOString(),
  };

  // Auto-reopen on low rating (≤ 2) for resolved issues
  let reopened = false;
  if (rating <= 2 && issue.status === "resolved") {
    updates.status = "reopened";
    updates.resolved_at = null;
    updates.closed_at = null;
    updates.reopen_count = (issue.reopen_count ?? 0) + 1;
    reopened = true;
    // Revoke the provisional score — it needs to be resolved properly again.
    updates.kpi_points = null;
    updates.kpi_breakdown = null;
  } else if (issue.status === "resolved" || issue.status === "closed") {
    // Top up the KPI score with the satisfaction bonus now that it's known.
    const { data: exts } = await supabase
      .from("facility_issue_tat_extensions")
      .select("kpi_exempt")
      .eq("issue_id", issue.id);
    const kpiResult = computeKpiPoints({
      priority: issue.priority as FacilityIssuePriority,
      slaBreached: issue.sla_breached ?? false,
      reopenCount: issue.reopen_count ?? 0,
      satisfactionRating: rating,
      extensionExemptFlags: (exts ?? []).map((e) => e.kpi_exempt),
    });
    updates.kpi_points = kpiResult.total;
    updates.kpi_breakdown = kpiResult.lines;
  }

  const { error: upErr } = await supabase
    .from("facility_issues").update(updates).eq("id", issue.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  if (reopened) {
    await supabase.from("facility_issue_kpi_credits").delete().eq("issue_id", issue.id);
    // Auto-reopen is a silent DB transition otherwise — the assignee would have no
    // idea their resolved ticket bounced back until they happened to check it.
    // Mirrors the manual-reopen path so it hits the same full-broadcast tier.
    await notifyIssueAssignee(
      { id: issue.id, category_id: issue.category_id, assigned_to: issue.assigned_to, issue_number: issue.issue_number, title: issue.title },
      {
        type: "status_changed", from: "resolved", to: "reopened",
        actorName: `Auto-reopened — ${rating}★ satisfaction rating`,
      }
    );
  } else if (updates.kpi_points != null) {
    await writeKpiCredits(supabase, {
      issueId: issue.id,
      scope: issue.scope as string,
      assignedTo: issue.assigned_to,
      total: updates.kpi_points as number,
    });
  }

  await logIssueEvent(supabase, {
    issueId: issue.id,
    eventType: "satisfaction",
    actorLabel: "Reporter (public link)",
    message: `Rated ${rating}/5${comment ? `: ${comment.slice(0, 120)}` : ""}${reopened ? " — auto-reopened" : ""}`,
    payload: { rating, reopened },
  });

  if (reopened) {
    await logIssueEvent(supabase, {
      issueId: issue.id, eventType: "reopened",
      actorLabel: "System",
      message: "Auto-reopened due to low satisfaction rating",
      payload: { from: "resolved", to: "reopened", reason: "low_rating" },
    });
  }

  return NextResponse.json({ success: true, reopened });
}

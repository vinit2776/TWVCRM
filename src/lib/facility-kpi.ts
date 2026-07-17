/**
 * Facility KPI scoring — Work Orders + Tasks.
 *
 * Priority-weighted points, computed once per resolution (recomputed if a
 * ticket is reopened and resolved again). Pure function — no DB access —
 * so it's easy to unit test and safe to import client-side too. Returns a
 * line-by-line breakdown alongside the total so the score can be *explained*,
 * not just displayed — the breakdown is persisted (facility_issues.kpi_breakdown)
 * at the same time as kpi_points so it always matches what was actually
 * scored, even if the ticket's fields change later (e.g. a later reopen).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FacilityIssuePriority } from "@/types";

/** A member collaborator's share of the ticket's kpi_points — primary gets 100%. */
export const MEMBER_KPI_WEIGHT = 0.25;

export const KPI_BASE_POINTS: Record<FacilityIssuePriority, number> = {
  critical: 400,
  high: 250,
  medium: 150,
  low: 80,
};

const SATISFACTION_BONUS = 100;
const REOPEN_PENALTY = 150;
const LATE_CONTROLLABLE_PENALTY = 200;

const PRIORITY_LABEL: Record<FacilityIssuePriority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export interface KpiBreakdownLine {
  label: string;
  delta: number;
}

export interface KpiResult {
  total: number;
  lines: KpiBreakdownLine[];
}

export function computeKpiPoints(params: {
  priority: FacilityIssuePriority;
  slaBreached: boolean;
  reopenCount: number;
  satisfactionRating?: number | null;
  /**
   * kpi_exempt flag of every extension used on this ticket (not just the
   * latest) — a single controllable (non-exempt) extension is enough to
   * count a breach against KPI, even if a later extension was exempt.
   * Empty array = no extensions used.
   */
  extensionExemptFlags: boolean[];
}): KpiResult {
  const lines: KpiBreakdownLine[] = [];

  const base = KPI_BASE_POINTS[params.priority];
  lines.push({ label: `${PRIORITY_LABEL[params.priority]} priority base`, delta: base });

  if ((params.satisfactionRating ?? 0) >= 4) {
    lines.push({ label: `Satisfaction rating ${params.satisfactionRating}★`, delta: SATISFACTION_BONUS });
  }

  if (params.reopenCount > 0) {
    lines.push({ label: `Reopened ${params.reopenCount}×`, delta: -REOPEN_PENALTY });
  }

  if (params.slaBreached) {
    const hasControllableExtension = params.extensionExemptFlags.some((exempt) => !exempt);
    const allExtensionsExempt = params.extensionExemptFlags.length > 0 && !hasControllableExtension;
    if (allExtensionsExempt) {
      lines.push({ label: "TAT breached — all extensions marked exempt, not counted", delta: 0 });
    } else {
      lines.push({ label: "TAT breached — counts against KPI", delta: -LATE_CONTROLLABLE_PENALTY });
    }
  }

  const total = lines.reduce((sum, l) => sum + l.delta, 0);
  return { total, lines };
}

/**
 * Writes per-user KPI credit rows for a scored ticket: the assignee gets the
 * full total (role 'primary'), and any collaborator who is also a current
 * member of the ticket's department roster gets MEMBER_KPI_WEIGHT of the same
 * total, penalties included (role 'member'). Existing rows for the issue are
 * cleared first since this runs on every recompute (resolve, satisfaction
 * top-up, reopen, pass-card override) and past credits shouldn't linger.
 *
 * Deliberately scoped to department-roster members, not every collaborator —
 * someone added just to be looped in (not on the roster) doesn't get scored.
 */
export async function writeKpiCredits(
  supabase: SupabaseClient,
  params: { issueId: string; scope: string; assignedTo: string | null; total: number }
): Promise<void> {
  const { issueId, scope, assignedTo, total } = params;

  await supabase.from("facility_issue_kpi_credits").delete().eq("issue_id", issueId);

  const rows: { issue_id: string; user_id: string; role: "primary" | "member"; points: number }[] = [];
  if (assignedTo) {
    rows.push({ issue_id: issueId, user_id: assignedTo, role: "primary", points: total });
  }

  const { data: department } = await supabase
    .from("facility_departments")
    .select("id")
    .eq("scope", scope)
    .single();

  if (department?.id) {
    const [{ data: members }, { data: collaborators }] = await Promise.all([
      supabase.from("facility_department_members").select("user_id").eq("department_id", department.id),
      supabase.from("facility_issue_collaborators").select("user_id").eq("issue_id", issueId),
    ]);
    const memberIds = new Set((members ?? []).map((m) => m.user_id as string));
    const collaboratorIds = (collaborators ?? []).map((c) => c.user_id as string);
    for (const userId of collaboratorIds) {
      if (userId === assignedTo || !memberIds.has(userId)) continue;
      rows.push({
        issue_id: issueId,
        user_id: userId,
        role: "member",
        points: Math.round(total * MEMBER_KPI_WEIGHT * 100) / 100,
      });
    }
  }

  if (rows.length > 0) {
    await supabase.from("facility_issue_kpi_credits").upsert(rows, { onConflict: "issue_id,user_id" });
  }
}

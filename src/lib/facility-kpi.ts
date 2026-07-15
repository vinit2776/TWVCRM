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

import type { FacilityIssuePriority } from "@/types";

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
  /** true = latest extension was tagged/pass-carded exempt, false = controllable, null = no extension used */
  latestExtensionExempt: boolean | null;
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
    const exempt = params.latestExtensionExempt === true;
    if (exempt) {
      lines.push({ label: "TAT breached — extension marked exempt, not counted", delta: 0 });
    } else {
      lines.push({ label: "TAT breached — counts against KPI", delta: -LATE_CONTROLLABLE_PENALTY });
    }
  }

  const total = lines.reduce((sum, l) => sum + l.delta, 0);
  return { total, lines };
}

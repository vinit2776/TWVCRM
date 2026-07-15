/**
 * Facility KPI scoring — Work Orders + Tasks.
 *
 * Priority-weighted points, computed once per resolution (recomputed if a
 * ticket is reopened and resolved again). Pure function — no DB access —
 * so it's easy to unit test and to preview a hypothetical score in the UI.
 */

import type { FacilityIssuePriority } from "@/types";

export const KPI_BASE_POINTS: Record<FacilityIssuePriority, number> = {
  critical: 40,
  high: 25,
  medium: 15,
  low: 8,
};

const SATISFACTION_BONUS = 10;
const REOPEN_PENALTY = 15;
const LATE_CONTROLLABLE_PENALTY = 20;

export function computeKpiPoints(params: {
  priority: FacilityIssuePriority;
  slaBreached: boolean;
  reopenCount: number;
  satisfactionRating?: number | null;
  /** true = latest extension was tagged/pass-carded exempt, false = controllable, null = no extension used */
  latestExtensionExempt: boolean | null;
}): number {
  let points = KPI_BASE_POINTS[params.priority];

  if ((params.satisfactionRating ?? 0) >= 4) points += SATISFACTION_BONUS;
  if (params.reopenCount > 0) points -= REOPEN_PENALTY;

  if (params.slaBreached) {
    const exempt = params.latestExtensionExempt === true;
    if (!exempt) points -= LATE_CONTROLLABLE_PENALTY;
    // exempt: neutral — base points stand, no bonus, no penalty
  }

  return points;
}

/**
 * AMC lifecycle — single source of truth for status + label + lifecycle position.
 *
 * The stored `amc_status` column on purchase_orders is computed at PO creation
 * time and never recalculated. Anything user-facing should use computeAmcStatus()
 * so the badge reflects "today", not "the day the PO was created".
 */

import type { AmcStatus } from "@/types";

export interface AmcLifecycle {
  /** Computed status reflecting today's date + visit usage */
  status: AmcStatus;
  /** Human-readable badge text, e.g. "Activates in 7 days" or "Active · 363 days left" */
  label: string;
  /** Tailwind colour classes for the badge */
  badgeClass: string;
  /** Days from today to amc_start_date (negative if started) — null if no start date */
  daysToStart: number | null;
  /** Days from today to amc_end_date (negative if expired) — null if no end date */
  daysToEnd: number | null;
  /** True when start_date is in the future */
  isPendingActivation: boolean;
}

interface Input {
  amc_start_date?: string | null;
  amc_end_date?: string | null;
  amc_visits_covered?: number | null;
  amc_visits_used?: number | null;
}

/** Days between two dates, rounded down. b - a. */
function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/** Pluralisation helper for "1 day" vs "5 days" */
function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

const EXPIRING_THRESHOLD_DAYS = 60;

const BADGE_CLASSES: Record<AmcStatus, string> = {
  inactive:  "bg-amber-100 text-amber-800 border-amber-200",
  active:    "bg-emerald-100 text-emerald-800 border-emerald-200",
  expiring:  "bg-orange-100 text-orange-800 border-orange-200",
  exhausted: "bg-rose-100 text-rose-800 border-rose-200",
  expired:   "bg-rose-100 text-rose-800 border-rose-200",
};

export function computeAmcLifecycle(po: Input, today: Date = new Date()): AmcLifecycle {
  // Normalise today to midnight so daysBetween is whole-day stable
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const start = po.amc_start_date ? new Date(po.amc_start_date) : null;
  const end = po.amc_end_date ? new Date(po.amc_end_date) : null;
  const visitsCovered = po.amc_visits_covered ?? null;
  const visitsUsed = po.amc_visits_used ?? 0;

  const daysToStart = start ? daysBetween(todayMid, start) : null;
  const daysToEnd = end ? daysBetween(todayMid, end) : null;

  // ── No start date set at all ───────────────────────────────────────────────
  if (!start) {
    return {
      status: "inactive",
      label: "Inactive — start date not set",
      badgeClass: BADGE_CLASSES.inactive,
      daysToStart: null,
      daysToEnd,
      isPendingActivation: false,
    };
  }

  // ── Start date is in the future → "Activates in N days" ────────────────────
  if (daysToStart !== null && daysToStart > 0) {
    return {
      status: "inactive",
      label: daysToStart === 1 ? "Activates tomorrow" : `Activates in ${days(daysToStart)}`,
      badgeClass: BADGE_CLASSES.inactive,
      daysToStart,
      daysToEnd,
      isPendingActivation: true,
    };
  }

  // ── Already past end date → Expired ────────────────────────────────────────
  if (end && daysToEnd !== null && daysToEnd < 0) {
    return {
      status: "expired",
      label: `Expired ${days(Math.abs(daysToEnd))} ago`,
      badgeClass: BADGE_CLASSES.expired,
      daysToStart,
      daysToEnd,
      isPendingActivation: false,
    };
  }

  // ── Visits exhausted (only counts when limit is finite) ────────────────────
  if (visitsCovered !== null && visitsUsed >= visitsCovered) {
    return {
      status: "exhausted",
      label: `Exhausted (${visitsUsed}/${visitsCovered} visits used)`,
      badgeClass: BADGE_CLASSES.exhausted,
      daysToStart,
      daysToEnd,
      isPendingActivation: false,
    };
  }

  // ── Expiring soon ──────────────────────────────────────────────────────────
  if (end && daysToEnd !== null && daysToEnd <= EXPIRING_THRESHOLD_DAYS) {
    return {
      status: "expiring",
      label: `Expiring · ${days(daysToEnd)} left`,
      badgeClass: BADGE_CLASSES.expiring,
      daysToStart,
      daysToEnd,
      isPendingActivation: false,
    };
  }

  // ── Active ─────────────────────────────────────────────────────────────────
  return {
    status: "active",
    label: daysToEnd !== null ? `Active · ${days(daysToEnd)} remaining` : "Active",
    badgeClass: BADGE_CLASSES.active,
    daysToStart,
    daysToEnd,
    isPendingActivation: false,
  };
}

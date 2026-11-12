"use client";

import { useCallback, useEffect, useState } from "react";
import type { QueryStats } from "@/lib/queries/types";

/**
 * Counts for the sidebar's "something is waiting on you" badges.
 *
 * Both come from the existing queries stats endpoint, which is already
 * role-filtered server-side, so a role that can't act on a thing gets zero
 * rather than a number it can never clear.
 *
 * Refreshes on a slow poll, when the tab regains focus, and whenever a screen
 * that settles a query dispatches QUERIES_CHANGED_EVENT — so verifying a
 * payment clears the badge now, not three minutes later.
 */
export const QUERIES_CHANGED_EVENT = "queries:changed";

export type SidebarBadgeKey = "queries_awaiting" | "payments_to_verify";

const POLL_MS = 3 * 60 * 1000;

export function useSidebarBadges(enabled: boolean): Partial<Record<SidebarBadgeKey, number>> {
  const [stats, setStats] = useState<Pick<QueryStats, "awaiting_you" | "to_verify"> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/queries?stats=true", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { stats?: QueryStats };
      if (json.stats) setStats({ awaiting_you: json.stats.awaiting_you, to_verify: json.stats.to_verify });
    } catch {
      // A missing badge is better than a broken sidebar.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener(QUERIES_CHANGED_EVENT, onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(QUERIES_CHANGED_EVENT, onFocus);
    };
  }, [enabled, refresh]);

  return {
    queries_awaiting: stats?.awaiting_you ?? 0,
    payments_to_verify: stats?.to_verify ?? 0,
  };
}

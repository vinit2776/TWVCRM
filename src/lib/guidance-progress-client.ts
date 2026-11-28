"use client";

import { useCallback, useEffect, useState } from "react";
import type { GuidanceProgress } from "@/lib/vo-renewal-learning";

export type GuidanceEvent = "completed" | "blocked";

/**
 * Tell the server a person finished, or failed at, a guided step. Fire and
 * forget: guidance is an aid, so a failure here must never get in the way of
 * the action the person just took.
 */
export function reportGuidance(stepKey: string, event: GuidanceEvent): void {
  fetch("/api/guidance/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step_key: stepKey, event }),
  }).catch(() => {
    // Not worth interrupting the user for a missed counter.
  });
}

/** The signed-in person's progress, keyed by step; `loaded` is false until it arrives. */
export function useGuidanceProgress() {
  const [progress, setProgress] = useState<Record<string, GuidanceProgress>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/guidance/progress")
      .then((r) => r.json())
      .then((j) => {
        if (live && j?.data) setProgress(j.data);
      })
      .catch(() => {
        // Without progress everything shows its long form, which is the safe default.
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  /** Record locally too, so the screen reacts without waiting for a reload. */
  const record = useCallback((stepKey: string, event: GuidanceEvent) => {
    reportGuidance(stepKey, event);
    const now = new Date().toISOString();
    setProgress((prev) => {
      const cur = prev[stepKey] ?? { times_completed: 0, last_completed_at: null, last_blocked_at: null };
      return {
        ...prev,
        [stepKey]:
          event === "completed"
            ? { ...cur, times_completed: cur.times_completed + 1, last_completed_at: now }
            : { ...cur, last_blocked_at: now },
      };
    });
  }, []);

  return { progress, loaded, record };
}

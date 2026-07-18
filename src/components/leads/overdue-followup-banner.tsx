"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

interface Summary {
  overdue: number;
  due_today: number;
}

export function OverdueFollowupBanner({ onReview }: { onReview: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    fetch("/api/leads/followup-summary")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setSummary(json))
      .catch(() => {});
  }, []);

  if (!summary || summary.overdue === 0) return null;

  return (
    <div className="rounded-lg border-2 border-red-300 bg-red-50/60 dark:bg-red-950/20 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
          <span className="text-sm font-medium text-red-800 dark:text-red-200">
            {summary.overdue} overdue follow-up{summary.overdue === 1 ? "" : "s"} need
            {summary.overdue === 1 ? "s" : ""} action
          </span>
          {summary.due_today > 0 && (
            <span className="text-xs text-red-700/80 dark:text-red-300/80">
              (+{summary.due_today} due today)
            </span>
          )}
        </div>
        <button
          onClick={onReview}
          className="text-xs font-medium text-red-700 hover:underline underline-offset-2"
        >
          Review now →
        </button>
      </div>
    </div>
  );
}

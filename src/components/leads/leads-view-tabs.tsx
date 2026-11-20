"use client";

import type { LeadsView } from "@/lib/leads-views";

export interface LeadsViewTab {
  key: LeadsView;
  label: string;
  count: number;
  /** Classes for the count badge. */
  tone: string;
}

/** The row of views at the top of the Leads page. Pure presentation: the page owns the counts and the active view. */
export function LeadsViewTabs({ tabs, active, onSelect }: { tabs: LeadsViewTab[]; active: LeadsView; onSelect: (view: LeadsView) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onSelect(t.key)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
            active === t.key ? "bg-foreground text-background border-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {t.label}
          {t.count > 0 && (
            <span className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${t.tone}`}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

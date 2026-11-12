"use client";

import { useState } from "react";
import { CalendarClock, X } from "lucide-react";

/**
 * Optional "needed by" date on a query.
 *
 * Presets rather than a bare date field, because the useful answers are
 * relative ("before I close the books on Friday") and nobody wants to open a
 * calendar to say "in three days". Setting one is opt-in on purpose: only
 * queries with a needed_by are ever chased, so a due date keeps meaning
 * something instead of becoming a field everyone fills in with noise.
 */

const PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "No date", days: null },
  { label: "Today", days: 0 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
];

/** Local-date ISO (YYYY-MM-DD) — never toISOString(), which shifts the date
 *  across the day boundary for anyone east of UTC, i.e. everyone here. */
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function NeededByPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const [customOpen, setCustomOpen] = useState(false);

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <CalendarClock className="h-3 w-3" />
        Needed by
      </span>

      {PRESETS.map((p) => {
        const iso = p.days === null ? null : isoDaysFromNow(p.days);
        const active = value === iso;
        return (
          <button
            key={p.label}
            type="button"
            disabled={disabled}
            onClick={() => {
              setCustomOpen(false);
              onChange(iso);
            }}
            className={`text-[11px] px-2 py-0.5 rounded border transition-colors disabled:opacity-50 ${
              active
                ? "bg-foreground text-background border-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {p.label}
          </button>
        );
      })}

      {customOpen ? (
        <span className="inline-flex items-center gap-1">
          <input
            type="date"
            value={value ?? ""}
            min={isoDaysFromNow(0)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value || null)}
            className="text-[11px] border rounded px-1.5 py-0.5 bg-background"
          />
          <button
            type="button"
            onClick={() => setCustomOpen(false)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close date picker"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setCustomOpen(true)}
          className="text-[11px] px-2 py-0.5 rounded border border-dashed text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          Pick a date
        </button>
      )}
    </div>
  );
}

"use client";

import { diffDays, type Journey, type JourneyBar } from "@/lib/customer-value/journey";
import { cn, formatDate } from "@/lib/utils";

interface JourneyTimelineProps {
  journey: Journey;
  today: string;
}

const BAR_STYLE: Record<string, string> = {
  enquiry: "bg-slate-200 text-slate-800",
  contract: "bg-emerald-600 text-white",
  ended: "bg-slate-500 text-white",
  pending: "border border-dashed border-blue-500 bg-blue-50 text-blue-900",
};

function barStyle(bar: JourneyBar): string {
  if (bar.kind === "enquiry") return BAR_STYLE.enquiry;
  if (bar.kind === "pending") return BAR_STYLE.pending;
  return bar.status === "active" || bar.status === "renewal_in_progress"
    ? BAR_STYLE.contract
    : BAR_STYLE.ended;
}

/**
 * One row per contract, positioned on a shared date axis, with the gaps
 * between contracts and a today marker. Plain HTML — no chart library.
 */
export function JourneyTimeline({ journey, today }: JourneyTimelineProps) {
  const totalDays = Math.max(1, diffDays(journey.axis.from, journey.axis.to) + 1);
  const pct = (days: number) => `${(days / totalDays) * 100}%`;
  const todayLeft = pct(diffDays(journey.axis.from, today));

  const rows: Array<{
    key: string;
    left: string;
    width: string;
    className: string;
    label: string;
    title: string;
    /** Bars this narrow cannot hold their label, so it sits beside them. */
    narrow: boolean;
  }> = [];

  // Under this share of the axis a label no longer fits inside its bar.
  const NARROW_BELOW = 0.14;

  for (const bar of journey.bars) {
    const span = diffDays(bar.from, bar.to) + 1;
    rows.push({
      key: bar.id,
      left: pct(diffDays(journey.axis.from, bar.from)),
      width: pct(span),
      className: barStyle(bar),
      label: bar.seats ? `${bar.label} · ${bar.seats} ${bar.seats === 1 ? "seat" : "seats"}` : bar.label,
      title: `${bar.label}: ${formatDate(bar.from)} to ${formatDate(bar.to)}`,
      narrow: span / totalDays < NARROW_BELOW,
    });
  }
  for (const gap of journey.gaps) {
    rows.push({
      key: `gap-${gap.from}`,
      left: pct(diffDays(journey.axis.from, gap.from)),
      width: pct(gap.days),
      className: "border border-dashed border-red-500 bg-red-50 text-red-800",
      label: `Break · ${gap.days} d`,
      title: `No contract from ${formatDate(gap.from)} to ${formatDate(gap.to)}`,
      narrow: gap.days / totalDays < NARROW_BELOW,
    });
  }

  return (
    <div className="space-y-2">
      <div className="relative" style={{ height: rows.length * 28 }}>
        {rows.map((row, i) => (
          <div key={row.key}>
            <div
              title={row.title}
              className={cn(
                "absolute h-6 overflow-hidden whitespace-nowrap rounded px-2 text-xs leading-6",
                row.className
              )}
              style={{ left: row.left, width: row.width, top: i * 28, minWidth: 6 }}
            >
              {row.narrow ? "" : row.label}
            </div>
            {row.narrow && (
              <span
                className="absolute whitespace-nowrap text-xs leading-6 text-foreground"
                style={{ left: `calc(${row.left} + ${row.width} + 8px)`, top: i * 28 }}
              >
                {row.label}
              </span>
            )}
          </div>
        ))}
        <div
          className="pointer-events-none absolute inset-y-0 border-l border-dashed border-foreground/70"
          style={{ left: todayLeft }}
          aria-hidden="true"
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatDate(journey.axis.from)}</span>
        <span>Dashed line: today</span>
        <span>{formatDate(journey.axis.to)}</span>
      </div>
    </div>
  );
}

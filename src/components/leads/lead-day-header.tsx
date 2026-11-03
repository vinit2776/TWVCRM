import { LEAD_SOURCE_LABELS } from "@/lib/constants";
import { dayLabel, type DaySummary } from "@/lib/lead-days";

/**
 * The heading above one day's leads: the day, how many came in, and from where. Counts come from the
 * whole day when known (`summary`), otherwise from the leads on this page, so a day that continues
 * onto the next page never shows a short count as if it were the total.
 */
export function LeadDayHeader({
  dayKey,
  summary,
  pageCount,
}: {
  dayKey: string;
  summary: DaySummary | undefined;
  pageCount: number;
}) {
  const total = summary?.total ?? pageCount;
  const sources = summary ? Object.entries(summary.sources).sort((a, b) => b[1] - a[1]) : [];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-muted/50 px-4 py-2">
      <div className="text-sm">
        <span className="font-semibold">{dayLabel(dayKey)}</span>
        <span className="text-muted-foreground"> · {total} {total === 1 ? "lead" : "leads"}</span>
      </div>
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map(([source, n]) => (
            <span key={source} className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
              {LEAD_SOURCE_LABELS[source] ?? source} {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

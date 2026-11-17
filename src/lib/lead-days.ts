// Grouping the Leads list by the day each lead came in, in IST (the team's day, not the server's).

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The IST calendar day of an instant, as "yyyy-MM-dd". */
export function istDayKey(iso: string | Date): string {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "Today · Wed 4 Nov", "Yesterday · Tue 3 Nov", then "Mon 2 Nov" (with the year once it is not this year). */
export function dayLabel(key: string, now: Date = new Date()): string {
  const day = new Date(`${key}T00:00:00Z`);
  const today = istDayKey(now);
  const base = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(key.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
    timeZone: "UTC",
  })
    .format(day)
    .replace(",", "");
  if (key === today) return `Today · ${base}`;
  if (key === istDayKey(new Date(now.getTime() - DAY_MS))) return `Yesterday · ${base}`;
  return base;
}

/** Consecutive runs of leads that share an IST day, in the order given (the list is newest-first). */
export function groupByDay<T extends { created_at: string }>(leads: T[]): { key: string; leads: T[] }[] {
  const groups: { key: string; leads: T[] }[] = [];
  for (const lead of leads) {
    const key = istDayKey(lead.created_at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.leads.push(lead);
    else groups.push({ key, leads: [lead] });
  }
  return groups;
}

export interface DaySummary {
  total: number;
  /** Leads that came in that day, by source. */
  sources: Record<string, number>;
}

/** Counts per IST day and source for a set of leads' creation times. */
export function summariseDays(rows: { created_at: string; source: string }[]): Record<string, DaySummary> {
  const out: Record<string, DaySummary> = {};
  for (const r of rows) {
    const key = istDayKey(r.created_at);
    const day = (out[key] ??= { total: 0, sources: {} });
    day.total += 1;
    day.sources[r.source] = (day.sources[r.source] ?? 0) + 1;
  }
  return out;
}

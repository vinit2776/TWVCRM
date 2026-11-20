import { istDayKey } from "@/lib/lead-days";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The pills on the Follow-ups tab. `none` is every open lead with nothing pending. */
export type FollowUpGroup = "overdue" | "today" | "tomorrow" | "week" | "later" | "none" | "next7" | "month";
/** The pills on the Follow-ups tab, in order. */
export const FOLLOW_UP_GROUPS: FollowUpGroup[] = ["overdue", "today", "tomorrow", "week", "later", "none"];
/**
 * Windows the Leads Home reads on top of the pills: `next7` is tomorrow to a week away, `month` is
 * eight to thirty days away. They overlap the pills (a lead in `month` is also in `later`), so they
 * are listed apart from FOLLOW_UP_GROUPS and never shown as pills.
 */
export const FOLLOW_UP_WINDOWS: FollowUpGroup[] = ["next7", "month"];
export const ALL_FOLLOW_UP_GROUPS: FollowUpGroup[] = [...FOLLOW_UP_GROUPS, ...FOLLOW_UP_WINDOWS];

/** Which Home window a follow-up falls in, counted in IST days; null when it is overdue, today, or beyond a month. */
export function followUpWindow(dueAt: string, now: Date = new Date()): "next7" | "month" | null {
  const days = Math.round((Date.parse(istDayKey(dueAt)) - Date.parse(istDayKey(now))) / DAY_MS);
  if (days >= 1 && days <= 7) return "next7";
  if (days >= 8 && days <= 30) return "month";
  return null;
}

/** Which pill a lead's next follow-up falls under, counted in IST days (the team's day, not the server's). */
export function followUpGroup(dueAt: string, now: Date = new Date()): Exclude<FollowUpGroup, "none"> {
  const days = Math.round((Date.parse(istDayKey(dueAt)) - Date.parse(istDayKey(now))) / DAY_MS);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "week";
  return "later";
}

export interface GroupedFollowUps {
  counts: Record<FollowUpGroup, number>;
  /** Lead ids per group, in the order the group shows them. */
  ids: Record<FollowUpGroup, string[]>;
}

/**
 * Sorts open leads into the groups. `nextDue` is each lead's soonest pending follow-up; a lead
 * missing from it has none. Dated groups run soonest first, so Overdue starts with the longest
 * overdue; the leads with no next step run newest first.
 */
export function groupFollowUps(
  nextDue: Map<string, string>,
  openLeads: { id: string; created_at: string }[],
  now: Date = new Date()
): GroupedFollowUps {
  const ids: Record<FollowUpGroup, string[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [], none: [], next7: [], month: [] };
  const dated = [...nextDue].sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]) || a[0].localeCompare(b[0]));
  for (const [id, due] of dated) {
    ids[followUpGroup(due, now)].push(id);
    const window = followUpWindow(due, now);
    if (window) ids[window].push(id);
  }

  ids.none = openLeads
    .filter((l) => !nextDue.has(l.id))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id))
    .map((l) => l.id);

  const counts = Object.fromEntries(ALL_FOLLOW_UP_GROUPS.map((g) => [g, ids[g].length])) as Record<FollowUpGroup, number>;
  return { counts, ids };
}

/** The soonest pending follow-up per lead, from a list of them in any order. */
export function soonestPerLead(rows: { lead_id: string; follow_up_date: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const cur = out.get(r.lead_id);
    if (!cur || Date.parse(r.follow_up_date) < Date.parse(cur)) out.set(r.lead_id, r.follow_up_date);
  }
  return out;
}

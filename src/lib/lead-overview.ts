// The numbers behind Leads → Overview. Pure: the API loads the rows, this turns them into the
// cards, the focus list and the per-location profile, so every figure can be tested.
import { assessValue, seatBand, SEAT_BANDS, REQUEST_THEMES, type ValueTier } from "@/lib/lead-value";

export interface OverviewLead {
  id: string;
  leadNumber: number | string;
  name: string;
  company: string | null;
  status: string;
  source: string;
  workspaceType: string | null;
  seats: number | null;
  /** What they said they can spend, per seat per month. */
  budgetPerSeat: number | null;
  locationId: string | null;
  locationName: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  createdAt: string;
  archivedAt: string | null;
  /** When someone first did something on it (not the system's own notes). */
  firstResponseAt: string | null;
  /** Days the oldest pending follow-up is overdue, or null when none is. */
  overdueDays: number | null;
  /** Theme keys found in what they wrote. */
  themes: string[];
}

export type RateLookup = (locationId: string | null, workspaceType: string | null) => number | null;

const FINISHED = ["won", "lost", "junk"];
const DAY_MS = 24 * 60 * 60 * 1000;

export const isOpen = (l: OverviewLead) => !l.archivedAt && !FINISHED.includes(l.status);

export interface Scored extends OverviewLead {
  monthly: number | null;
  estimated: boolean;
  tier: ValueTier;
  reasons: string[];
}

export function score(l: OverviewLead, rate: RateLookup, now: Date): Scored {
  const v = assessValue({
    seats: l.seats,
    workspaceType: l.workspaceType,
    budgetPerSeat: l.budgetPerSeat,
    standardRate: rate(l.locationId, l.workspaceType),
    hasCompany: !!l.company,
    now,
  });
  return { ...l, ...v };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const share = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export interface Bar { key: string; label: string; count: number; value: number; avg: number | null }

function groupBars(rows: Scored[], keyOf: (l: Scored) => string | null, labelOf: (k: string) => string): Bar[] {
  const m = new Map<string, Scored[]>();
  for (const l of rows) {
    const k = keyOf(l) ?? "none";
    (m.get(k) ?? m.set(k, []).get(k)!).push(l);
  }
  return [...m.entries()]
    .map(([key, ls]) => {
      const valued = ls.filter((l) => l.monthly !== null);
      const value = sum(valued.map((l) => l.monthly as number));
      return { key, label: labelOf(key), count: ls.length, value, avg: valued.length ? Math.round(value / valued.length) : null };
    })
    .sort((a, b) => b.value - a.value || b.count - a.count);
}

export interface FocusItem {
  id: string;
  leadNumber: number | string;
  name: string;
  company: string | null;
  source: string;
  monthly: number | null;
  estimated: boolean;
  tier: ValueTier;
  reasons: string[];
  want: string;
  location: string | null;
  handler: string | null;
  unclaimedMinutes: number | null;
  overdueDays: number | null;
}

export interface ProfileInsight { text: string }

export interface Overview {
  cards: { actNow: number; pipeline: number; waiting: number; oldestWaitingMinutes: number | null; passing: number };
  focus: FocusItem[];
  byLocation: Bar[];
  bySource: Bar[];
  profile: null | {
    enquiries: number;
    previous: number;
    avgBudget: number | null;
    ourRate: number | null;
    medianResponseMinutes: number | null;
    waitingNow: number;
    won: number;
    stillOpen: number;
    types: (Bar & { countShare: number; valueShare: number })[];
    seatBands: { key: string; label: string; count: number; share: number }[];
    budgetBuckets: { key: string; label: string; count: number; share: number }[];
    budgetBase: number;
    requests: { key: string; label: string; count: number }[];
    sources: { key: string; label: string; count: number; avg: number | null; won: number; usuallyAsks: string }[];
    insights: ProfileInsight[];
  };
}

export interface OverviewInput {
  leads: OverviewLead[];
  rate: RateLookup;
  now: Date;
  windowDays: number;
  /** null = all locations. */
  locationId: string | null;
  labelSource: (key: string) => string;
  labelType: (key: string) => string;
  /** The numbers on the "our rate" line: one representative standard rate for the chosen location. */
  ourRate: number | null;
}

function wantLine(l: Scored, labelType: (k: string) => string): string {
  const parts: string[] = [];
  if (l.workspaceType) parts.push(labelType(l.workspaceType));
  if (l.seats) parts.push(`${l.seats} seat${l.seats === 1 ? "" : "s"}`);
  if (l.budgetPerSeat) parts.push(`budget ₹${l.budgetPerSeat.toLocaleString("en-IN")}`);
  return parts.length ? parts.join(" · ") : "No requirement recorded";
}

export function buildOverview(i: OverviewInput): Overview {
  const cutoff = i.now.getTime() - i.windowDays * DAY_MS;
  const prevCutoff = cutoff - i.windowDays * DAY_MS;
  const inLocation = (l: OverviewLead) => i.locationId === null || l.locationId === i.locationId;

  const scoredAll = i.leads.filter(inLocation).map((l) => score(l, i.rate, i.now));
  const current = scoredAll.filter((l) => Date.parse(l.createdAt) >= cutoff);
  const previous = scoredAll.filter((l) => Date.parse(l.createdAt) < cutoff && Date.parse(l.createdAt) >= prevCutoff);

  // The working queue is everything still open, however old: the window only shapes the analysis.
  const open = scoredAll.filter(isOpen);
  const waitingLeads = open.filter((l) => !l.assignedTo);
  const waitMinutes = waitingLeads.map((l) => Math.max(0, Math.round((i.now.getTime() - Date.parse(l.createdAt)) / 60000)));
  const needsAction = (l: Scored) => !l.assignedTo || l.overdueDays !== null || l.status === "new";
  const actNow = open.filter((l) => l.tier === "high" && needsAction(l));

  const focus: FocusItem[] = [...actNow]
    .sort((a, b) => (b.monthly ?? 0) - (a.monthly ?? 0))
    .slice(0, 10)
    .map((l) => ({
      id: l.id,
      leadNumber: l.leadNumber,
      name: l.name,
      company: l.company,
      source: l.source,
      monthly: l.monthly,
      estimated: l.estimated,
      tier: l.tier,
      reasons: l.reasons,
      want: wantLine(l, i.labelType),
      location: l.locationName,
      handler: l.assigneeName,
      unclaimedMinutes: l.assignedTo ? null : Math.max(0, Math.round((i.now.getTime() - Date.parse(l.createdAt)) / 60000)),
      overdueDays: l.overdueDays,
    }));

  const byLocation = groupBars(current, (l) => l.locationId, (k) => current.find((l) => (l.locationId ?? "none") === k)?.locationName ?? "No location given");
  const bySource = groupBars(current, (l) => l.source, i.labelSource).sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));

  const overview: Overview = {
    cards: {
      actNow: actNow.length,
      pipeline: sum(open.filter((l) => l.monthly !== null).map((l) => l.monthly as number)),
      waiting: waitingLeads.length,
      oldestWaitingMinutes: waitMinutes.length ? Math.max(...waitMinutes) : null,
      passing: open.filter((l) => l.tier === "passing").length,
    },
    focus,
    byLocation,
    bySource,
    profile: null,
  };

  if (i.locationId === null) return overview;

  // ── The profile of one location ──
  const budgets = current.filter((l) => l.budgetPerSeat);
  const types = groupBars(current, (l) => l.workspaceType, i.labelType).map((b) => ({
    ...b,
    countShare: share(b.count, current.length),
    valueShare: share(b.value, sum(current.map((l) => l.monthly ?? 0))),
  }));
  const bandCounts = SEAT_BANDS.map((b) => ({ key: b.key, label: b.label, count: current.filter((l) => seatBand(l.seats) === b.key).length }));
  const bandBase = sum(bandCounts.map((b) => b.count));
  const rate = i.ourRate;
  const bucketDefs = rate
    ? [
        { key: "low", label: `Under ₹${Math.round(rate * 0.67).toLocaleString("en-IN")}`, test: (b: number) => b < rate * 0.67 },
        { key: "mid", label: `₹${Math.round(rate * 0.67).toLocaleString("en-IN")} – ${rate.toLocaleString("en-IN")}`, test: (b: number) => b >= rate * 0.67 && b < rate },
        { key: "high", label: `₹${rate.toLocaleString("en-IN")} and above`, test: (b: number) => b >= rate },
      ]
    : [];
  const budgetBuckets = bucketDefs.map((d) => {
    const count = budgets.filter((l) => d.test(l.budgetPerSeat as number)).length;
    return { key: d.key, label: d.label, count, share: share(count, budgets.length) };
  });
  const themeCounts = REQUEST_THEMES.map((t) => ({ key: t.key, label: t.label, count: current.filter((l) => l.themes.includes(t.key)).length }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);
  const sources = groupBars(current, (l) => l.source, i.labelSource).map((b) => {
    const rows = current.filter((l) => l.source === b.key);
    const topType = groupBars(rows, (l) => l.workspaceType, i.labelType)[0];
    const seatsRows = rows.filter((l) => l.seats);
    const medSeats = median(seatsRows.map((l) => l.seats as number));
    return {
      key: b.key,
      label: b.label,
      count: b.count,
      avg: b.avg,
      won: rows.filter((l) => l.status === "won").length,
      usuallyAsks: topType && topType.key !== "none" ? `${topType.label}${medSeats ? `, ~${medSeats} seats` : ""}` : "—",
    };
  });
  const responseMinutes = current
    .filter((l) => l.firstResponseAt)
    .map((l) => Math.max(0, Math.round((Date.parse(l.firstResponseAt as string) - Date.parse(l.createdAt)) / 60000)));

  const insights: ProfileInsight[] = [];
  const topType = types.find((t) => t.key !== "none");
  if (topType && current.length >= 5) {
    const belowRate = budgetBuckets.filter((b) => b.key !== "high").reduce((a, b) => a + b.share, 0);
    insights.push({
      text: `Most people ask for ${topType.label.toLowerCase()} (${topType.countShare}%)${rate && budgets.length >= 5 ? `, and ${belowRate}% budget below our ₹${rate.toLocaleString("en-IN")} rate` : ""}.`,
    });
  }
  const richest = [...types].filter((t) => t.key !== "none").sort((a, b) => b.valueShare - a.valueShare)[0];
  if (richest && richest.valueShare >= richest.countShare + 15 && current.length >= 5) {
    insights.push({ text: `${richest.label} are only ${richest.countShare}% of enquiries but ${richest.valueShare}% of the value. Chase those first.` });
  }
  const topSource = [...sources].sort((a, b) => b.count - a.count)[0];
  const bestSource = [...sources].filter((s) => s.count >= 2 && s.avg !== null).sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0))[0];
  if (topSource && bestSource && topSource.key !== bestSource.key) {
    insights.push({ text: `${topSource.label} brings the most enquiries (${topSource.count}); ${bestSource.label} brings fewer but the biggest (average ₹${(bestSource.avg ?? 0).toLocaleString("en-IN")}).` });
  }

  overview.profile = {
    enquiries: current.length,
    previous: previous.length,
    avgBudget: budgets.length ? Math.round(sum(budgets.map((l) => l.budgetPerSeat as number)) / budgets.length) : null,
    ourRate: rate,
    medianResponseMinutes: median(responseMinutes),
    waitingNow: waitingLeads.length,
    won: current.filter((l) => l.status === "won").length,
    stillOpen: current.filter(isOpen).length,
    types,
    seatBands: bandCounts.map((b) => ({ ...b, share: share(b.count, bandBase) })),
    budgetBuckets,
    budgetBase: budgets.length,
    requests: themeCounts,
    sources,
    insights,
  };
  return overview;
}

/** "47 min", "3 h 5 min", "2 days". */
export function formatWait(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const d = Math.floor(minutes / (24 * 60));
  return `${d} day${d === 1 ? "" : "s"}`;
}

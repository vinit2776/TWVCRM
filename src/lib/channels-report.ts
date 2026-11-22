import { NON_EVENT_SUBJECTS } from "@/lib/lead-stale";

// The Channels report: which source sends enquiries that actually become customers, not just
// enquiries. One definition of each step so the screen and the numbers behind it always agree.
//  - Enquiries: leads that came in during the period, by source.
//  - Junk: leads marked junk.
//  - Reached: someone got through to the person: a call that was not "no answer", or any reply, meeting,
//    email or tour logged on the lead (or an update on its enquiry other than "called, no answer").
//  - Tours: a tour was booked. Proposals: a proposal was made. Won: a contract was ACTIVATED for the lead.
//  - Cost per win: the spend of the promotions tied to that source, counted only for the days they
//    overlap the period, divided by the wins.

/** A channel with fewer enquiries than this is shown as "too few to judge" instead of a verdict. */
export const TOO_FEW_TO_JUDGE = 10;

export interface ChannelLead {
  source: string;
  createdAt: string;
  status: string;
  /** The first moment someone did something real on it, or null. */
  firstTouchAt: string | null;
  reached: boolean;
  hasTour: boolean;
  hasProposal: boolean;
  won: boolean;
}

export interface ChannelRow {
  source: string;
  enquiries: number;
  junk: number;
  reached: number;
  tours: number;
  proposals: number;
  won: number;
  junkRate: number;
  winRate: number;
  /** Median minutes from arrival to first touch, or null when none were touched. */
  firstContactMinutes: number | null;
  spend: number;
  costPerWin: number | null;
  verdict: Verdict;
}

export type VerdictKey = "too_few" | "too_much_junk" | "grow" | "fix" | "keep" | "watch";
export interface Verdict {
  key: VerdictKey;
  label: string;
  tone: "good" | "bad" | "mid";
}

/**
 * Where a channel stands against the others. Needs TOO_FEW_TO_JUDGE enquiries or says so. Then, in
 * this order: a third or more junk is too much junk; clearly the best converter with little junk is
 * one to grow; a big channel that converts poorly needs fixing or its spend cut; a decent converter
 * is a keep; the rest to watch. `avgEnquiries` and `overallWinRate` are across all the channels.
 */
export function channelVerdict(r: { enquiries: number; junkRate: number; winRate: number }, avgEnquiries: number, overallWinRate: number): Verdict {
  if (r.enquiries < TOO_FEW_TO_JUDGE) return { key: "too_few", label: "Too few to judge", tone: "mid" };
  if (r.junkRate >= 0.3) return { key: "too_much_junk", label: "Too much junk", tone: "bad" };
  if (r.winRate >= 1.5 * overallWinRate && r.junkRate < 0.15) return { key: "grow", label: "Grow this", tone: "good" };
  if (r.enquiries >= avgEnquiries && r.winRate < 0.6 * overallWinRate) return { key: "fix", label: "Fix or cut spend", tone: "bad" };
  if (r.winRate >= 0.8 * overallWinRate) return { key: "keep", label: "Keep", tone: "good" };
  return { key: "watch", label: "Watch", tone: "mid" };
}

export interface Promotion {
  source: string | null;
  startsOn: string; // yyyy-MM-dd
  endsOn: string | null; // null = still running
  spend: number | null;
}

const DAY_MS = 86400000;
const dayNum = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY_MS);

/**
 * The part of a promotion's spend that falls in the period: its spend spread evenly over its days,
 * times the days that overlap [from, to]. A promotion still running is counted up to `today`. A
 * promotion with no spend entered is 0.
 */
export function proratedSpend(p: Promotion, from: string, to: string, today: string): number {
  if (!p.spend || p.spend <= 0) return 0;
  const start = dayNum(p.startsOn);
  const end = dayNum(p.endsOn ?? today);
  if (end < start) return 0;
  const overlap = Math.min(end, dayNum(to)) - Math.max(start, dayNum(from)) + 1;
  if (overlap <= 0) return 0;
  return (p.spend * overlap) / (end - start + 1);
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** The funnel per source, biggest first, with a verdict each. */
export function channelFunnel(leads: ChannelLead[], promotions: Promotion[], from: string, to: string, today: string): ChannelRow[] {
  const bySource = new Map<string, ChannelLead[]>();
  for (const l of leads) bySource.set(l.source, [...(bySource.get(l.source) ?? []), l]);

  const base = [...bySource].map(([source, list]) => {
    const enquiries = list.length;
    const junk = list.filter((l) => l.status === "junk").length;
    const won = list.filter((l) => l.won).length;
    const minutes = list.filter((l) => l.firstTouchAt).map((l) => Math.max(0, Math.round((Date.parse(l.firstTouchAt as string) - Date.parse(l.createdAt)) / 60000)));
    const spend = Math.round(promotions.filter((p) => p.source === source).reduce((s, p) => s + proratedSpend(p, from, to, today), 0));
    return {
      source,
      enquiries,
      junk,
      reached: list.filter((l) => l.reached).length,
      tours: list.filter((l) => l.hasTour).length,
      proposals: list.filter((l) => l.hasProposal).length,
      won,
      junkRate: enquiries ? junk / enquiries : 0,
      winRate: enquiries ? won / enquiries : 0,
      firstContactMinutes: median(minutes),
      spend,
      costPerWin: won > 0 && spend > 0 ? Math.round(spend / won) : null,
    };
  });
  const totalEnq = base.reduce((s, r) => s + r.enquiries, 0);
  const overallWin = totalEnq ? base.reduce((s, r) => s + r.won, 0) / totalEnq : 0;
  const avgEnq = base.length ? totalEnq / base.length : 0;
  return base
    .map((r) => ({ ...r, verdict: channelVerdict(r, avgEnq, overallWin) }))
    .sort((a, b) => b.enquiries - a.enquiries || a.source.localeCompare(b.source));
}

/** A readable name for a source the labels do not know: "online_form" reads "Online form". */
export function sourceLabel(source: string, known: Record<string, string>): string {
  if (known[source]) return known[source];
  const words = source.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

/** A call that was not "no answer" counts as reaching them; so does anything else a person logged. */
export function reachedBy(activity: { type: string; callOutcome?: string | null; subject?: string | null }): boolean {
  if ((NON_EVENT_SUBJECTS as readonly string[]).includes(activity.subject ?? "")) return false;
  if (activity.type === "call") return !!activity.callOutcome && activity.callOutcome !== "no_answer" && activity.callOutcome !== "voicemail" && activity.callOutcome !== "busy" && activity.callOutcome !== "wrong_number";
  return ["meeting", "email", "tour"].includes(activity.type);
}

export interface TrustFacts {
  /** Channels that were shown without a verdict because they had too few enquiries. */
  tooFewChannels: number;
  totalChannels: number;
  /** Contracts activated in the period with no lead on them, so no channel can claim them. */
  untracedDeals: number;
  tracedDeals: number;
  /** Leads nobody has touched (no first touch), as a share of all enquiries. */
  untouched: number;
  enquiries: number;
  /** Ad channels with enquiries but no spend entered, so no cost per win can be shown. */
  adChannelsWithoutSpend: string[];
}

export interface TrustLine {
  label: string;
  detail: string;
  tone: "good" | "warn";
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** The caveats to read before trusting the table, in plain words. */
export function trustLines(t: TrustFacts): TrustLine[] {
  const lines: TrustLine[] = [];
  lines.push(
    t.untracedDeals === 0
      ? { label: "Every new customer is traced to a channel", detail: `${t.tracedDeals} lead${t.tracedDeals === 1 ? "" : "s"} became customers in the period, and no contract was activated without a lead on it.`, tone: "good" }
      : { label: "Some customers cannot be traced to a channel", detail: `${t.untracedDeals} contract${t.untracedDeals === 1 ? "" : "s"} activated in the period ${t.untracedDeals === 1 ? "has" : "have"} no lead on ${t.untracedDeals === 1 ? "it" : "them"}, so no channel gets the credit (${t.tracedDeals} did).`, tone: "warn" },
  );
  lines.push(
    t.tooFewChannels === 0
      ? { label: "Every channel has enough enquiries to judge", detail: `All ${t.totalChannels} have ${TOO_FEW_TO_JUDGE} or more.`, tone: "good" }
      : { label: "Some channels are too small to judge", detail: `${t.tooFewChannels} of ${t.totalChannels} have under ${TOO_FEW_TO_JUDGE} enquiries, so they get no verdict.`, tone: "warn" },
  );
  lines.push(
    pct(t.untouched, t.enquiries) >= 20
      ? { label: "Many enquiries were never touched", detail: `${t.untouched} of ${t.enquiries} (${pct(t.untouched, t.enquiries)}%) have no call or note, which drags every channel's numbers down.`, tone: "warn" }
      : { label: "Most enquiries were worked", detail: `${t.enquiries - t.untouched} of ${t.enquiries} have been touched.`, tone: "good" },
  );
  if (t.adChannelsWithoutSpend.length > 0) {
    lines.push({ label: "No spend entered for some ad channels", detail: `${t.adChannelsWithoutSpend.join(", ")}: add the campaign's spend under Leads promotions to see cost per win.`, tone: "warn" });
  }
  return lines;
}

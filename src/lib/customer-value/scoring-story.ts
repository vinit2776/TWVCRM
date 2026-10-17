/**
 * Customer Value scoring — the story and the suggested action.
 *
 * Rules, not generated prose: up to five short sentences in a fixed priority
 * order, each tied to a metric (and to the records behind it when the caller
 * passes them), plus one suggested action picked from a short fixed list. Every
 * claim can therefore be traced to data. See docs/plans/customer-value-phase2.md,
 * section 4.
 *
 * Pure module: no database, no clock.
 */

import type { CustomerScore } from "@/lib/customer-value/scoring-overall";
import type { Tier } from "@/lib/customer-value/scoring-settings";
import type { Trend } from "@/lib/customer-value/scoring-overall";

export type StoryMetric = "payment" | "open_problems" | "direction" | "usage" | "renewal";

export type ActionCode =
  | "clear_tickets_before_renewal"
  | "chase_overdue_invoices"
  | "review_seat_count"
  | "protect"
  | "not_enough_data"
  | "monitor";

export interface StoryFacts {
  /** Average days late over recent paid invoices; negative means early. */
  avgDaysLate: number | null;
  /** Reminders sent in the last 90 days. */
  reminders90d: number | null;
  /** Unpaid invoices past their due date. */
  overdueInvoices: { count: number; maxDays: number } | null;
  /** Tickets past their target resolution time. */
  overdueTickets: number | null;
  /** Share of paid seats actually used, 0 to 100; null where door data is missing. */
  seatsUsedPct: number | null;
  /** Days until the current contract ends; null if there is no current contract. */
  renewalInDays: number | null;
  /** The tier and overall score at the start of the trend comparison. */
  previous?: { tier: Tier | null; overall: number | null } | null;
  /** Record ids to attach to each sentence so it can link to its evidence. */
  evidence?: Partial<Record<StoryMetric, string[]>>;
}

export interface StorySentence {
  metric: StoryMetric;
  text: string;
  /** Ids of the invoices, tickets or contracts this sentence rests on. */
  evidence: string[];
}

export interface SuggestedAction {
  code: ActionCode;
  text: string;
}

export interface Story {
  sentences: StorySentence[];
  action: SuggestedAction;
}

const MAX_SENTENCES = 5;
/** A renewal further out than this is not worth a sentence. */
const RENEWAL_HORIZON_DAYS = 120;
const RENEWAL_ACTION_DAYS_TICKETS = 90;
const OVERDUE_CHASE_DAYS = 14;
const LOW_SEAT_USE_PCT = 50;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function oneDecimal(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function buildStory(score: CustomerScore, trend: Trend | null, facts: StoryFacts): Story {
  const ev = (m: StoryMetric): string[] => facts.evidence?.[m] ?? [];
  const sentences: StorySentence[] = [];

  // 1. Standing: how they pay.
  if (facts.avgDaysLate !== null) {
    const days = Math.abs(facts.avgDaysLate);
    let text: string;
    if (days < 1) text = "Pays on or close to the due date";
    else text = `Pays about ${oneDecimal(days)} days ${facts.avgDaysLate > 0 ? "late" : "early"}`;
    if (facts.reminders90d !== null && facts.reminders90d > 0) {
      text += `, with ${plural(facts.reminders90d, "reminder")} in the last 90 days`;
    }
    sentences.push({ metric: "payment", text: `${text}.`, evidence: ev("payment") });
  }

  // 2. Open problems right now.
  const problems: string[] = [];
  if (facts.overdueInvoices && facts.overdueInvoices.count > 0) {
    problems.push(
      `${plural(facts.overdueInvoices.count, "unpaid invoice")}, up to ${plural(facts.overdueInvoices.maxDays, "day")} overdue`
    );
  }
  if (facts.overdueTickets && facts.overdueTickets > 0) {
    problems.push(`${plural(facts.overdueTickets, "ticket")} overdue`);
  }
  if (problems.length > 0) {
    sentences.push({ metric: "open_problems", text: `${problems.join(" and ")}.`, evidence: ev("open_problems") });
  }

  // 3. Direction, only when the move is real and both ends are known.
  if (score.status === "graded" && score.tier && trend && trend !== "flat" && facts.previous?.tier) {
    const word = trend === "down" ? "down" : "up";
    sentences.push({
      metric: "direction",
      text: `Score is ${word} from ${facts.previous.tier} to ${score.tier} over the last 90 days.`,
      evidence: ev("direction"),
    });
  }

  // 4. Usage, where door data exists.
  if (facts.seatsUsedPct !== null) {
    sentences.push({
      metric: "usage",
      text: `Uses ${Math.round(facts.seatsUsedPct)}% of the seats they pay for.`,
      evidence: ev("usage"),
    });
  }

  // 5. Renewal context.
  if (facts.renewalInDays !== null && facts.renewalInDays >= 0 && facts.renewalInDays <= RENEWAL_HORIZON_DAYS) {
    sentences.push({
      metric: "renewal",
      text: `Renewal is in ${plural(facts.renewalInDays, "day")}.`,
      evidence: ev("renewal"),
    });
  }

  return { sentences: sentences.slice(0, MAX_SENTENCES), action: pickAction(score, trend, facts) };
}

function pickAction(score: CustomerScore, trend: Trend | null, facts: StoryFacts): SuggestedAction {
  const renewal = facts.renewalInDays;
  const overdueTickets = facts.overdueTickets ?? 0;
  const overdue = facts.overdueInvoices;
  const hasOpenProblems = overdueTickets > 0 || (overdue?.count ?? 0) > 0;

  if (overdueTickets > 0 && renewal !== null && renewal >= 0 && renewal <= RENEWAL_ACTION_DAYS_TICKETS) {
    return {
      code: "clear_tickets_before_renewal",
      text: "Clear the overdue tickets before the renewal conversation.",
    };
  }
  if (overdue && overdue.count > 0 && overdue.maxDays >= OVERDUE_CHASE_DAYS) {
    return { code: "chase_overdue_invoices", text: "Chase the overdue invoices." };
  }
  if (
    facts.seatsUsedPct !== null &&
    facts.seatsUsedPct < LOW_SEAT_USE_PCT &&
    renewal !== null &&
    renewal >= 0 &&
    renewal <= RENEWAL_HORIZON_DAYS
  ) {
    return { code: "review_seat_count", text: "Review the seat count before the renewal." };
  }
  if (score.status !== "graded") {
    return { code: "not_enough_data", text: "Not enough history yet to judge. Check back after a few months." };
  }
  if ((score.tier === "A" || score.tier === "B") && trend !== "down" && !hasOpenProblems) {
    return { code: "protect", text: "Strong and stable. Protect the relationship." };
  }
  return { code: "monitor", text: "No action needed right now." };
}

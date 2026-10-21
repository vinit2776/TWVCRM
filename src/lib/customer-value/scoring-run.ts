/**
 * Customer Value — scoring every customer as of a date.
 *
 * Takes each customer's raw records, rebuilds their monthly figures **as known
 * on that date** (so history is not graded with hindsight), ranks them against
 * the other customers at the same center, and produces the score, trend and
 * story. See docs/plans/customer-value-phase2.md, sections 3, 4 and 6.
 *
 * Percentile ranking needs the other customers' metric values, so each date is
 * scored in two passes: a first pass on the fixed reference scales to learn
 * everyone's metric values, then a second pass where each customer is ranked
 * against the others at their center (never against themselves).
 *
 * Pure module: no database, no clock.
 */

import { addDaysToYmd } from "@/lib/rate-phase-dates";
import { computeSettlement } from "@/lib/settlement";
import {
  buildJourney,
  contractRan,
  diffMonths,
  diffDays,
  type JourneyContractRow,
} from "@/lib/customer-value/journey";
import { isIssued, type MoneyPaymentRow } from "@/lib/customer-value/money";
import {
  buildMonthlyRows,
  monthEnd,
  monthRange,
  type CustomerRaw,
  type MonthlyRow,
} from "@/lib/customer-value/monthly-metrics";
import {
  scoreCustomer,
  trendBetween,
  type CustomerScore,
  type Trend,
} from "@/lib/customer-value/scoring-overall";
import type { CohortValues, MarginPoint } from "@/lib/customer-value/scoring-pillars";
import {
  PILLAR_KEYS,
  type MetricKey,
  type PillarKey,
  type ScoringSettings,
} from "@/lib/customer-value/scoring-settings";
import { buildStory, type Story, type StoryFacts } from "@/lib/customer-value/scoring-story";

export interface RunCustomer {
  leadId: string;
  raw: CustomerRaw;
  locationIds: string[];
  ticketLinkCoverage: number | null;
  /** Margin after variable costs by month; only loaded and read when the margin metric is on. */
  margin?: MarginPoint[];
}

export interface ScoredCustomer {
  leadId: string;
  asOf: string;
  score: CustomerScore;
  trend: Trend | null;
  /** The overall score 90 days earlier, when that could be computed. */
  previousOverall: number | null;
  story: Story;
}

/** The center a customer is ranked in: their first location, so the choice is stable. */
export function primaryLocation(c: Pick<RunCustomer, "locationIds">): string | null {
  return [...c.locationIds].sort()[0] ?? null;
}

function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ── Facts for one customer on one date ──────────────────────────────────

interface Prepared {
  customer: RunCustomer;
  rows: MonthlyRow[];
  tenureMonths: number | null;
  /** Contracts as they stood on the date: ones that had started by then. */
  contracts: JourneyContractRow[];
  renewal: { renewed: number; declined: number };
  escalations: Array<"accepted" | "reduced" | "avoided" | "unknown">;
  journeyCurrent: { contractId: string | null; endDate: string; daysToEnd: number } | null;
}

function prepare(customer: RunCustomer, asOf: string): Prepared {
  const rows = buildMonthlyRows(customer.raw, asOf);
  const contracts = customer.raw.contracts.filter((c) => c.start_date <= asOf);
  const ran = contracts.filter(contractRan);
  const first = ran.map((c) => c.start_date).sort()[0] ?? null;

  // The journey needs a lead creation date only for the "enquiry" bar, which scoring does not use.
  const journey = buildJourney({ lead: { created_at: `${asOf}T00:00:00Z`, source: null }, contracts, today: asOf });
  return {
    customer,
    rows,
    tenureMonths: first ? diffMonths(first, asOf) : null,
    contracts,
    renewal: { renewed: journey.renewalCount, declined: journey.renewalsDeclined },
    escalations: journey.escalations.map((e) => e.outcome),
    journeyCurrent: journey.current
      ? {
          contractId: ran.find((c) => c.contract_number === journey.current!.contractNumber)?.id ?? null,
          endDate: journey.current.endDate,
          daysToEnd: journey.current.daysToEnd,
        }
      : null,
  };
}

/** Metric values worth ranking against: scored ones that were measured, not rule-based. */
function metricValues(score: CustomerScore): Partial<Record<MetricKey, number>> {
  const out: Partial<Record<MetricKey, number>> = {};
  for (const k of PILLAR_KEYS) {
    for (const m of score.pillars[k].metrics) {
      if (m.status === "ok" && m.method !== "rule" && m.value !== null && Number.isFinite(m.value)) out[m.key] = m.value;
    }
  }
  return out;
}

// ── Open problems and evidence ──────────────────────────────────────────

export interface OverdueFacts {
  count: number;
  maxDays: number;
  ids: string[];
}

/** Unpaid invoices already past their due date as of `asOf`, judged with the payments known by then. */
export function overdueInvoicesAt(raw: CustomerRaw, asOf: string): OverdueFacts {
  let count = 0;
  let maxDays = 0;
  const ids: string[] = [];
  for (const s of raw.statements) {
    if (!isIssued(s.status) || !s.due_date || s.due_date >= asOf) continue;
    const pays: MoneyPaymentRow[] = raw.payments.filter(
      (p) => p.billing_statement_id === s.id && (p.payment_date ?? p.created_at.slice(0, 10)) <= asOf
    );
    if (computeSettlement(s.total_amount, pays).balanceDue <= 0) continue;
    count += 1;
    maxDays = Math.max(maxDays, diffDays(s.due_date, asOf));
    ids.push(s.id);
  }
  return { count, maxDays, ids };
}

function recentPayment(rows: MonthlyRow[]): { avgDaysLate: number | null; reminders90d: number } {
  const recent = rows.slice(-3);
  const measured = recent.reduce((n, r) => n + r.measured_count, 0);
  const late = recent.reduce((n, r) => n + (r.avg_days_late ?? 0) * r.measured_count, 0);
  return {
    avgDaysLate: measured > 0 ? late / measured : null,
    reminders90d: recent.reduce((n, r) => n + r.reminders, 0),
  };
}

function storyFacts(p: Prepared, asOf: string, previous: { tier: CustomerScore["tier"]; overall: number | null } | null): StoryFacts {
  const overdue = overdueInvoicesAt(p.customer.raw, asOf);
  const { avgDaysLate, reminders90d } = recentPayment(p.rows);
  const last = p.rows[p.rows.length - 1];
  const seatsUsedPct =
    last && last.seats_used_avg !== null && (last.seats_paid ?? 0) > 0
      ? (last.seats_used_avg / (last.seats_paid as number)) * 100
      : null;
  const recentInvoiceIds = p.customer.raw.statements
    .filter((s) => isIssued(s.status) && s.due_date && s.due_date <= asOf && s.due_date >= addDaysToYmd(asOf, -92))
    .map((s) => s.id)
    .slice(0, 5);

  return {
    avgDaysLate,
    reminders90d: p.rows.length > 0 ? reminders90d : null,
    overdueInvoices: overdue.count > 0 ? { count: overdue.count, maxDays: overdue.maxDays } : null,
    // Open facility tickets past their target are not tracked per customer yet, so this is honestly unknown.
    overdueTickets: null,
    seatsUsedPct,
    renewalInDays: p.journeyCurrent ? p.journeyCurrent.daysToEnd : null,
    previous: previous ? { tier: previous.tier, overall: previous.overall } : null,
    evidence: {
      payment: recentInvoiceIds,
      open_problems: overdue.ids.slice(0, 10),
      renewal: p.journeyCurrent?.contractId ? [p.journeyCurrent.contractId] : [],
    },
  };
}

// ── Scoring one date ────────────────────────────────────────────────────

interface DateResult {
  asOf: string;
  byLead: Map<string, { score: CustomerScore; prepared: Prepared }>;
}

function scoreDate(customers: RunCustomer[], asOf: string, settings: ScoringSettings): DateResult {
  const prepared = customers.map((c) => prepare(c, asOf));

  // Pass 1: fixed scales only, to learn everyone's metric values.
  const first = new Map<string, CustomerScore>();
  for (const p of prepared) {
    first.set(
      p.customer.leadId,
      scoreCustomer(
        { rows: p.rows, tenureMonths: p.tenureMonths, ticketLinkCoverage: p.customer.ticketLinkCoverage, renewal: p.renewal, escalations: p.escalations, margin: p.customer.margin },
        asOf,
        settings
      )
    );
  }

  // Who counts as a peer: established customers with figures, grouped by center.
  const peersByCenter = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const center = primaryLocation(p.customer);
    if (!center || p.rows.length === 0 || (p.tenureMonths ?? 0) < settings.minTenureMonths) continue;
    const list = peersByCenter.get(center) ?? [];
    list.push(p);
    peersByCenter.set(center, list);
  }

  // Pass 2: rank each customer against the others at their center.
  const byLead = new Map<string, { score: CustomerScore; prepared: Prepared }>();
  for (const p of prepared) {
    const center = primaryLocation(p.customer);
    const others = (center ? (peersByCenter.get(center) ?? []) : []).filter((o) => o.customer.leadId !== p.customer.leadId);

    const cohort: CohortValues = {};
    for (const o of others) {
      const values = metricValues(first.get(o.customer.leadId) as CustomerScore);
      for (const [key, value] of Object.entries(values) as Array<[MetricKey, number]>) {
        (cohort[key] ??= []).push(value);
      }
    }
    const centerRent = median(
      others.map((o) => o.rows[o.rows.length - 1]?.rent_per_seat).filter((v): v is number => v !== null && v !== undefined)
    );

    byLead.set(p.customer.leadId, {
      prepared: p,
      score: scoreCustomer(
        {
          rows: p.rows,
          tenureMonths: p.tenureMonths,
          ticketLinkCoverage: p.customer.ticketLinkCoverage,
          renewal: p.renewal,
          escalations: p.escalations,
          margin: p.customer.margin,
          centerRentPerSeat: centerRent,
          cohort,
        },
        asOf,
        settings
      ),
    });
  }
  return { asOf, byLead };
}

/**
 * Scores every customer as of each date, with the trend against 90 days before
 * and the story. `dates` are `YYYY-MM-DD`; the result is keyed by customer.
 */
export function scoreCustomersAt(
  customers: RunCustomer[],
  dates: string[],
  settings: ScoringSettings
): Map<string, ScoredCustomer[]> {
  const cache = new Map<string, DateResult>();
  const at = (d: string): DateResult => {
    const hit = cache.get(d);
    if (hit) return hit;
    const fresh = scoreDate(customers, d, settings);
    cache.set(d, fresh);
    return fresh;
  };

  const out = new Map<string, ScoredCustomer[]>();
  for (const asOf of dates) {
    const now = at(asOf);
    const earlier = at(addDaysToYmd(asOf, -90));
    for (const [leadId, { score, prepared }] of now.byLead) {
      const before = earlier.byLead.get(leadId)?.score ?? null;
      const trend = trendBetween(score.overall, before?.overall ?? null, settings.trendThreshold);
      const story = buildStory(
        score,
        trend,
        storyFacts(prepared, asOf, before ? { tier: before.tier, overall: before.overall } : null)
      );
      const list = out.get(leadId) ?? [];
      list.push({ leadId, asOf, score, trend, previousOverall: before?.overall ?? null, story });
      out.set(leadId, list);
    }
  }
  return out;
}

/** Month-end dates from a customer's first month to `today` (the last one is `today` if the month is unfinished). */
export function historyDates(firstMonth: string, today: string): string[] {
  return monthRange(firstMonth, today).map((m) => {
    const end = monthEnd(m);
    return end <= today ? end : today;
  });
}

// ── Storing ─────────────────────────────────────────────────────────────

export interface ScoreRecord {
  lead_id: string;
  as_of: string;
  payment: number | null;
  friction: number | null;
  engagement: number | null;
  profitability: number | null;
  confidence: Record<PillarKey, number>;
  overall: number | null;
  tier: string | null;
  status: string;
  reason: string | null;
  trend_vs_90d: Trend | null;
  method: Record<string, unknown>;
  story: Record<string, unknown>;
  settings_version: string;
  computed_at: string;
}

function r1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

export function toScoreRecord(s: ScoredCustomer, settingsVersion: string, computedAt: string): ScoreRecord {
  const { score } = s;
  const confidence = Object.fromEntries(
    PILLAR_KEYS.map((k) => [k, Math.round(score.pillars[k].confidence * 100) / 100])
  ) as Record<PillarKey, number>;
  return {
    lead_id: s.leadId,
    as_of: s.asOf,
    payment: r1(score.pillars.payment.score),
    friction: r1(score.pillars.friction.score),
    engagement: r1(score.pillars.engagement.score),
    profitability: r1(score.pillars.profitability.score),
    confidence,
    overall: r1(score.overall),
    tier: score.tier,
    status: score.status,
    reason: score.reason,
    trend_vs_90d: s.trend,
    method: {
      pillars: Object.fromEntries(
        PILLAR_KEYS.map((k) => [
          k,
          {
            notes: score.pillars[k].notes,
            months_used: score.pillars[k].monthsUsed,
            metrics: score.pillars[k].metrics.map((m) => ({
              key: m.key,
              status: m.status,
              method: m.method,
              cohort_size: m.cohortSize,
              value: m.value === null ? null : Math.round(m.value * 1000) / 1000,
              score: r1(m.score),
            })),
          },
        ])
      ),
      weights_used: score.weightsUsed,
      confident_pillars: score.confidentPillars,
      tier_cap: score.tierCap,
      previous_overall: r1(s.previousOverall),
    },
    story: { sentences: s.story.sentences, action: s.story.action },
    settings_version: settingsVersion,
    computed_at: computedAt,
  };
}

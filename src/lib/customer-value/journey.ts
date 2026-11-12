/**
 * Customer Value tab — Journey calculations.
 *
 * Pure functions (no database, no clock): everything the Journey sub-tab shows
 * about how long a customer has been with us, whether they broke, how often
 * they renewed, what rent they paid over time, and what happened on escalation.
 * See docs/customer-value-tab-spec.md, section 5.1.
 *
 * Dates are `YYYY-MM-DD` strings throughout (contract dates have no time part),
 * and `today` is injected so results are reproducible in tests.
 */

import {
  addDaysToYmd,
  computePhaseBoundaries,
  type RatePhaseInput,
} from "@/lib/rate-phase-dates";

// ── Input shapes ────────────────────────────────────────────────────────

export interface JourneyContractRow {
  id: string;
  contract_number: string;
  status: string;
  start_date: string;
  end_date: string;
  activated_at: string | null;
  terminated_at: string | null;
  seats: number | null;
  /** Monthly fixed rent before tax (contracts.subtotal). */
  subtotal: number | null;
  escalation_percentage: number | null;
  escalation_waived: boolean | null;
  escalation_approval_status: string | null;
  parent_contract_id: string | null;
  renewal_sequence: number | null;
  days_extended: number | null;
  phase_start_date: string | null;
  renewal_declined: boolean | null;
  /** Internal note on what was agreed when this renewal was negotiated (contracts.renewal_agreed_note). */
  renewal_agreed_note: string | null;
  rate_phases: RatePhaseInput[];
}

export interface JourneyInput {
  lead: { created_at: string; source: string | null };
  contracts: JourneyContractRow[];
  /** `YYYY-MM-DD` in IST. */
  today: string;
}

// ── Output shapes ───────────────────────────────────────────────────────

export type EscalationOutcome = "accepted" | "reduced" | "avoided" | "unknown";

export interface JourneyGap {
  from: string;
  to: string;
  days: number;
  afterContractNumber: string;
  beforeContractNumber: string;
}

export interface JourneyRentStep {
  contractId: string;
  contractNumber: string;
  from: string;
  to: string;
  monthlyRent: number;
  seats: number | null;
  /** monthlyRent ÷ seats, or null when seats are unknown. */
  perSeat: number | null;
}

export interface JourneyEscalationEvent {
  renewalContractId: string;
  renewalContractNumber: string;
  parentContractNumber: string;
  /** Renewal start date. */
  date: string;
  /** Parent contract's escalation clause — what we asked for. Null when unrecorded. */
  askedPct: number | null;
  /** Renewal contract's escalation — what was agreed. Null when unrecorded. */
  agreedPct: number | null;
  waived: boolean;
  outcome: EscalationOutcome;
  /** Movement in monthly rent per seat across the renewal, in percent. */
  rentPerSeatChangePct: number | null;
  approvalStatus: string | null;
  /** Internal note on what was agreed in the negotiation, when one was recorded. */
  agreedNote: string | null;
}

export type JourneyBarKind = "enquiry" | "contract" | "pending";

export interface JourneyBar {
  id: string;
  kind: JourneyBarKind;
  label: string;
  seats: number | null;
  from: string;
  to: string;
  status: string | null;
}

export interface Journey {
  /** False when the lead has no contract that ever ran. */
  hasHistory: boolean;
  leadCreatedAt: string;
  leadSource: string | null;
  customerSince: string | null;
  leadAgeMonths: number;
  tenureMonths: number | null;
  daysToFirstContract: number | null;
  ranContractCount: number;
  renewalCount: number;
  renewalsDeclined: number;
  gaps: JourneyGap[];
  breakCount: number;
  longestGapDays: number;
  extension: { events: number; totalDays: number; latestUsedDays: number; lifetimeCap: number };
  rentSteps: JourneyRentStep[];
  escalations: JourneyEscalationEvent[];
  bars: JourneyBar[];
  /** Bounds of the timeline axis. */
  axis: { from: string; to: string };
  /** The contract covering today, and the state of its renewal if one exists. */
  current: { contractNumber: string; endDate: string; daysToEnd: number; renewalDraftStatus: string | null } | null;
}

// ── Contract classification ────────────────────────────────────────────

/** Statuses that only exist for a contract that went live. */
const RAN_STATUSES = new Set(["active", "renewal_in_progress", "renewed", "expired"]);

/** Statuses of a contract that was created but has not started yet. */
const PENDING_STATUSES = new Set(["draft", "sent", "viewed", "accepted"]);

const EXTENSION_LIFETIME_CAP_DAYS = 60;

/**
 * Did this contract ever go live? A contract that was withdrawn before
 * activation is stored as `terminated` with no `activated_at`, and must not
 * count as history. Older rows may predate `activated_at`, so a status that can
 * only follow activation is accepted too.
 */
export function contractRan(c: Pick<JourneyContractRow, "status" | "activated_at">): boolean {
  return Boolean(c.activated_at) || RAN_STATUSES.has(c.status);
}

/** The last day the customer actually held the contract. */
export function effectiveEnd(c: Pick<JourneyContractRow, "status" | "end_date" | "terminated_at">): string {
  if (c.status === "terminated" && c.terminated_at) {
    const stopped = c.terminated_at.slice(0, 10);
    return stopped < c.end_date ? stopped : c.end_date;
  }
  return c.end_date;
}

// ── Date math ───────────────────────────────────────────────────────────

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `a` to `b` (negative when b is before a). */
export function diffDays(a: string, b: string): number {
  return Math.round((ymdToUtcMs(b) - ymdToUtcMs(a)) / 86_400_000);
}

/** Whole calendar months from `a` to `b`, never negative. */
export function diffMonths(a: string, b: string): number {
  const [ay, am, ad] = a.slice(0, 10).split("-").map(Number);
  const [by, bm, bd] = b.slice(0, 10).split("-").map(Number);
  let months = (by - ay) * 12 + (bm - am);
  if (bd < ad) months -= 1;
  return Math.max(0, months);
}

/** Today's date in IST as `YYYY-MM-DD`. */
export function todayYmdIst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

/** Date part of an ISO timestamp, read in IST. */
export function isoToYmdIst(iso: string): string {
  return todayYmdIst(new Date(iso));
}

// ── Rent ────────────────────────────────────────────────────────────────

function perSeat(rent: number, seats: number | null): number | null {
  return seats && seats > 0 ? rent / seats : null;
}

/**
 * Rent per month across a contract's life, one step per rate phase (or a
 * single step for a flat-rate contract), clipped to the days the customer held
 * the contract.
 */
export function rentStepsForContract(c: JourneyContractRow): JourneyRentStep[] {
  const end = effectiveEnd(c);
  const flat = Number(c.subtotal ?? 0);
  const make = (from: string, to: string, rent: number): JourneyRentStep | null => {
    const clippedFrom = from < c.start_date ? c.start_date : from;
    const clippedTo = to > end ? end : to;
    if (clippedFrom > clippedTo) return null;
    return {
      contractId: c.id,
      contractNumber: c.contract_number,
      from: clippedFrom,
      to: clippedTo,
      monthlyRent: rent,
      seats: c.seats,
      perSeat: perSeat(rent, c.seats),
    };
  };

  if (c.rate_phases.length === 0) {
    const step = make(c.start_date, end, flat);
    return step ? [step] : [];
  }

  const anchor = c.phase_start_date ?? c.start_date;
  const steps: JourneyRentStep[] = [];
  if (anchor > c.start_date) {
    const lead = make(c.start_date, addDaysToYmd(anchor, -1), flat);
    if (lead) steps.push(lead);
  }
  for (const b of computePhaseBoundaries(anchor, c.rate_phases)) {
    const step = make(b.start, b.end, b.rate);
    if (step) steps.push(step);
  }
  return steps;
}

// ── Escalation ──────────────────────────────────────────────────────────

export function classifyEscalation(
  asked: number | null,
  agreed: number | null,
  waived: boolean
): EscalationOutcome {
  if (waived) return "avoided";
  if (asked === null || agreed === null) return "unknown";
  if (agreed <= 0 && asked > 0) return "avoided";
  if (agreed < asked) return "reduced";
  return "accepted";
}

function numOrNull(v: number | null | undefined): number | null {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
}

// ── Main ────────────────────────────────────────────────────────────────

export function buildJourney(input: JourneyInput): Journey {
  const { lead, contracts, today } = input;
  const leadCreated = isoToYmdIst(lead.created_at);
  const byId = new Map(contracts.map((c) => [c.id, c]));

  const ran = contracts
    .filter(contractRan)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));

  const pending = contracts.filter((c) => !contractRan(c) && PENDING_STATUSES.has(c.status));

  const customerSince = ran[0]?.start_date ?? null;

  // Gaps: compare each contract's start with the furthest end seen so far, so
  // an overlapping pair is never mistaken for a break.
  const gaps: JourneyGap[] = [];
  if (ran.length > 0) {
    let coverEnd = effectiveEnd(ran[0]);
    let coverNumber = ran[0].contract_number;
    for (const c of ran.slice(1)) {
      const days = diffDays(coverEnd, c.start_date) - 1;
      if (days > 0) {
        gaps.push({
          from: addDaysToYmd(coverEnd, 1),
          to: addDaysToYmd(c.start_date, -1),
          days,
          afterContractNumber: coverNumber,
          beforeContractNumber: c.contract_number,
        });
      }
      const end = effectiveEnd(c);
      if (end > coverEnd) {
        coverEnd = end;
        coverNumber = c.contract_number;
      }
    }
  }

  const rentSteps = ran.flatMap(rentStepsForContract);

  const escalations: JourneyEscalationEvent[] = [];
  for (const c of ran) {
    const parent = c.parent_contract_id ? byId.get(c.parent_contract_id) : undefined;
    if (!parent) continue;
    const asked = numOrNull(parent.escalation_percentage);
    const agreed = numOrNull(c.escalation_percentage);
    const waived = Boolean(c.escalation_waived);

    const before = [...rentStepsForContract(parent)].pop();
    const after = rentStepsForContract(c)[0];
    const rentPerSeatChangePct =
      before?.perSeat && after?.perSeat ? ((after.perSeat - before.perSeat) / before.perSeat) * 100 : null;

    escalations.push({
      renewalContractId: c.id,
      renewalContractNumber: c.contract_number,
      parentContractNumber: parent.contract_number,
      date: c.start_date,
      askedPct: asked,
      agreedPct: agreed,
      waived,
      outcome: classifyEscalation(asked, agreed, waived),
      rentPerSeatChangePct,
      approvalStatus: c.escalation_approval_status,
      agreedNote: c.renewal_agreed_note?.trim() || null,
    });
  }

  const extensionRows = ran.filter((c) => (c.days_extended ?? 0) > 0);
  const latest = ran[ran.length - 1];

  const bars: JourneyBar[] = [];
  if (customerSince && leadCreated < customerSince) {
    bars.push({
      id: "enquiry",
      kind: "enquiry",
      label: "Enquiry",
      seats: null,
      from: leadCreated,
      to: addDaysToYmd(customerSince, -1),
      status: null,
    });
  }
  for (const c of ran) {
    bars.push({
      id: c.id,
      kind: "contract",
      label: c.contract_number,
      seats: c.seats,
      from: c.start_date,
      to: effectiveEnd(c),
      status: c.status,
    });
  }
  for (const c of pending) {
    bars.push({
      id: c.id,
      kind: "pending",
      label: c.contract_number,
      seats: c.seats,
      from: c.start_date,
      to: c.end_date,
      status: c.status,
    });
  }

  const axisFrom = bars.reduce((min, b) => (b.from < min ? b.from : min), leadCreated);
  const axisToBase = bars.reduce((max, b) => (b.to > max ? b.to : max), today);
  const axisTo = axisToBase > today ? axisToBase : addDaysToYmd(today, 30);

  // The contract covering today, whatever its status: a contract already marked
  // `renewed` still holds the customer until its end date, and a renewal that
  // starts next month is not current yet.
  const live = [...ran].reverse().find((c) => c.start_date <= today && effectiveEnd(c) >= today);
  const renewal = live
    ? contracts.find(
        (c) => c.parent_contract_id === live.id && (contractRan(c) || PENDING_STATUSES.has(c.status))
      )
    : undefined;

  return {
    hasHistory: ran.length > 0,
    leadCreatedAt: leadCreated,
    leadSource: lead.source,
    customerSince,
    leadAgeMonths: diffMonths(leadCreated, today),
    tenureMonths: customerSince ? diffMonths(customerSince, today) : null,
    daysToFirstContract: customerSince ? Math.max(0, diffDays(leadCreated, customerSince)) : null,
    ranContractCount: ran.length,
    renewalCount: ran.filter((c) => c.parent_contract_id && byId.has(c.parent_contract_id)).length,
    renewalsDeclined: contracts.filter((c) => c.renewal_declined).length,
    gaps,
    breakCount: gaps.length,
    longestGapDays: gaps.reduce((max, g) => Math.max(max, g.days), 0),
    extension: {
      events: extensionRows.length,
      totalDays: extensionRows.reduce((sum, c) => sum + (c.days_extended ?? 0), 0),
      latestUsedDays: latest?.days_extended ?? 0,
      lifetimeCap: EXTENSION_LIFETIME_CAP_DAYS,
    },
    rentSteps,
    escalations,
    bars,
    axis: { from: axisFrom, to: axisTo },
    current: live
      ? {
          contractNumber: live.contract_number,
          endDate: effectiveEnd(live),
          daysToEnd: diffDays(today, effectiveEnd(live)),
          renewalDraftStatus: renewal?.status ?? null,
        }
      : null,
  };
}

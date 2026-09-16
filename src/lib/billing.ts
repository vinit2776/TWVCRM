/**
 * Monthly billing — shared statement-generation logic.
 *
 * Used by:
 *   • /api/billing/auto-generate          (cron, runs last day of every month at 21:00 IST)
 *   • /api/billing/auto-generate (POST)   (manual trigger from UI)
 *   • /api/contracts/[id] PATCH           (when a contract flips to "active",
 *                                          generate the current month's bill
 *                                          right away so mid-month activations
 *                                          don't have to wait for next cron)
 *
 * Invoice structure (generated on last day of month M):
 *   Section A — Prepaid rent for month M+1
 *   Section B — Current month (M) itemized usage:
 *     • Auto-rolled contract bookings (free quota at ₹0, paid at actuals)
 *     • Ad-hoc usage charges (manual entries)
 *     • Facility usage records (meeting room quota overages)
 *     • Service usage records (printer/service overages)
 *
 * Why centralised: the generator is non-trivial (proration, GST split between
 * intra/inter-state, usage-charge linking, facility + service usage rollup,
 * booking auto-rollup) and we need the exact same logic to run from at least
 * three call sites. Keeping it here means there's one source of truth.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeGstAndRounding } from "@/lib/gst-math";
import { logAudit } from "@/lib/audit";
import { computePhaseBoundaries, daysBetweenInclusiveYmd, addDaysToYmd, formatDateRange, type PhaseBoundary } from "@/lib/rate-phase-dates";
import { BILLING_CYCLE_MONTHS } from "@/lib/constants";
// These sat mid-file, inside the block the deprecated combined generator
// occupied. Nothing imports back into this module, so there's no cycle keeping
// them down there — they belong with the rest of the imports.
import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";
import { createAdminClient } from "@/lib/supabase/server";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";

export interface GenerateOptions {
  /** Target month (1-12). Defaults to current month in IST. */
  month?: number;
  /** Target year. Defaults to current year in IST. */
  year?: number;
  /** Restrict to a single contract (used by the activation hook). */
  contractId?: string;
  /**
   * Preview mode. When true, compute what WOULD be generated (amounts, GST,
   * after applying all gates + idempotency) and push it to result.preview[],
   * but write NOTHING and dispatch NOTHING. Used by the manual "Preview" button.
   */
  dryRun?: boolean;
}

/** One row of a dry-run preview — what a single statement would contain. */
export interface PreviewItem {
  contract_number: string;
  customer_name?: string;
  type: "rent" | "usage";
  /** Human label, e.g. "June 2026" */
  period_label: string;
  subtotal: number;
  tax_amount: number;
  cgst_amount?: number;
  sgst_amount?: number;
  total_amount: number;
  /** Itemised breakdown for the expandable detail view */
  line_items?: { description: string; amount: number; note?: string }[];
  /** For rent: whether it would be prorated. For usage: the chargeable categories present. */
  note?: string;
  /**
   * If set, this generation would supersede an existing unsent legacy combined
   * statement (e.g., "TWV-BS-0070"). Used to surface the cutover to the operator.
   */
  supersedes?: string;
  /**
   * Usage only. If set, this generation would create a SUPPLEMENTAL statement
   * topping up an already-sent/paid usage statement (e.g., "TWV-BS-0009") —
   * new usage_charges/service_usage_records surfaced after the original went
   * out. The original is never reopened; this is a second, smaller statement
   * cross-referenced to it via supplements_statement_id.
   */
  supplements?: string;
}

export interface GenerateResult {
  month: number;
  year: number;
  generated: number;
  skipped: number;
  errors: string[];
  /** IDs of generated statements — used by callers that want to email. */
  statementIds: string[];
  /** Contract numbers skipped because lead has no email AND no phone/mobile. */
  noContact: string[];
  /** Contract numbers whose statement was raised and finalized but never
   *  reached the client (dispatch failed for a reason other than no-contact).
   *  These need a manual resend — the idempotency partition treats a finalized
   *  statement as already-sent, so no later run picks them back up. */
  notDelivered: string[];
  /** Contract numbers skipped by the advance-cycle billing gate — quarterly /
   *  half-yearly / yearly contracts whose next_billing_date doesn't fall in the
   *  prepaid month (expected, not errors). */
  cycleSkipped: string[];
  /** Statement numbers of legacy combined drafts that were voided so a fresh
   *  rent + usage split could replace them. Cutover housekeeping — surfaced in
   *  the operator confirmation so they know what's being replaced. */
  superseded: string[];
  /** Contracts skipped because a covering statement was already SENT to the
   *  client (proforma_sent_at set) or paid or GST-issued — never replaced. */
  alreadySent: string[];
  /** Usage only. Contract numbers for which a SUPPLEMENTAL statement was
   *  created — new usage found after the covering statement was already
   *  sent/paid. See PreviewItem.supplements and the generator's own
   *  doc comment for the full picture (why this exists, and why it's
   *  deliberately limited to ad-hoc charges + print/service usage, never
   *  facility usage or bookings). */
  supplemental: string[];
  /** Populated only in dryRun mode: what each contract WOULD be billed. */
  preview: PreviewItem[];
}

// ── Line-item types for the JSONB column ──────────────────────────────────

interface LineItemSection {
  type: "prepaid_rent" | "booking_usage" | "ad_hoc_charges" | "facility_usage" | "service_usage";
  label: string;
  items: Record<string, unknown>[];
  subtotal: number;
}

// ── Space allocation → rent line item enrichment ───────────────────────────
// contract_space_allocations links a contract to one or more space_units
// (Location/Name/Type/Seats). Most contracts predate this being wired into
// billing, so a contract with no linked allocation keeps the plain
// "Monthly rent (N seats)" line it's always had.

const SPACE_UNIT_TYPE_LABELS: Record<string, string> = {
  hot_desk: "Hot Desk",
  dedicated_desk: "Dedicated Desk",
  private_cabin: "Private Cabin",
  managed_office: "Managed Office",
  business_centre: "Business Centre",
};

type SpaceAllocationDetail = { name: string; type: string; capacity: number; locationName: string | null };

/** contract_id → active space_unit allocations, for a set of contracts. */
async function fetchSpaceAllocationsByContract(
  supabase: SupabaseClient,
  contractIds: string[]
): Promise<Map<string, SpaceAllocationDetail[]>> {
  const map = new Map<string, SpaceAllocationDetail[]>();
  if (contractIds.length === 0) return map;

  const { data: allocations } = await supabase
    .from("contract_space_allocations")
    .select("contract_id, space_unit:space_units(name, type, capacity, location_id)")
    .in("contract_id", contractIds)
    .eq("status", "active");

  type SpaceUnitRow = { name: string; type: string; capacity: number; location_id: string };
  type AllocationRow = { contract_id: string; space_unit: SpaceUnitRow | SpaceUnitRow[] | null };

  const locationIds = new Set<string>();
  const parsed: { contract_id: string; name: string; type: string; capacity: number; location_id: string }[] = [];
  for (const row of (allocations ?? []) as AllocationRow[]) {
    const unit = Array.isArray(row.space_unit) ? row.space_unit[0] : row.space_unit;
    if (!unit) continue;
    parsed.push({ contract_id: row.contract_id, name: unit.name, type: unit.type, capacity: Number(unit.capacity) || 1, location_id: unit.location_id });
    if (unit.location_id) locationIds.add(unit.location_id);
  }
  if (parsed.length === 0) return map;

  const { data: locations } = await supabase
    .from("locations")
    .select("id, name")
    .in("id", Array.from(locationIds));
  const locationNames = new Map((locations ?? []).map((l) => [l.id as string, l.name as string]));

  for (const p of parsed) {
    const list = map.get(p.contract_id) ?? [];
    list.push({ name: p.name, type: p.type, capacity: p.capacity, locationName: locationNames.get(p.location_id) ?? null });
    map.set(p.contract_id, list);
  }
  return map;
}

/**
 * contract_id → contract's own location name, used as a Location fallback when
 * no specific room (contract_space_allocations) is mapped — every contract
 * has a location, only some have a room assigned within it.
 */
async function fetchLocationNamesByContract(
  supabase: SupabaseClient,
  contracts: Array<{ id: string; location_id?: string | null }>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const locationIds = [...new Set(contracts.map((c) => c.location_id).filter((id): id is string => !!id))];
  if (locationIds.length === 0) return map;

  const { data: locations } = await supabase.from("locations").select("id, name").in("id", locationIds);
  const nameById = new Map((locations ?? []).map((l) => [l.id as string, l.name as string]));

  for (const c of contracts) {
    if (c.location_id && nameById.has(c.location_id)) map.set(c.id, nameById.get(c.location_id) as string);
  }
  return map;
}

export type RatePhaseDetail = { phase_order: number; duration_months: number; monthly_rate: number; end_date: string | null };

/** contract_id → its tiered rate_phases (any order), for a set of contracts. */
export async function fetchRatePhasesByContract(
  supabase: SupabaseClient,
  contractIds: string[]
): Promise<Map<string, RatePhaseDetail[]>> {
  const map = new Map<string, RatePhaseDetail[]>();
  if (contractIds.length === 0) return map;

  const { data } = await supabase
    .from("contract_rate_phases")
    .select("contract_id, phase_order, duration_months, monthly_rate, end_date")
    .in("contract_id", contractIds);

  for (const row of (data ?? []) as Array<RatePhaseDetail & { contract_id: string }>) {
    const list = map.get(row.contract_id) ?? [];
    list.push({ phase_order: row.phase_order, duration_months: row.duration_months, monthly_rate: row.monthly_rate, end_date: row.end_date ?? null });
    map.set(row.contract_id, list);
  }
  return map;
}

export type RenewalDraftPricing = {
  id: string;
  start_date: string;
  end_date: string;
  total_amount: number;
  subtotal: number | null;
  tax_percentage: number | null;
  phase_start_date: string | null;
  seats: number | null;
};

/**
 * parent_contract_id → its current (non-rejected) renewal draft, for a set of
 * renewal_in_progress parents. Once a parent's own end_date has lapsed, rent
 * billing must switch to the renewal draft's escalated terms (rate, seats,
 * phase schedule) rather than the parent's stale pre-renewal terms — the old
 * contract keeps billing continuity, but at the negotiated new rate.
 * A parent can have more than one draft row (e.g. a prior rejected attempt);
 * `renewal_sequence desc` + first-wins-per-parent keeps only the latest.
 */
async function fetchActiveRenewalDraftsByParentId(
  supabase: SupabaseClient,
  parentIds: string[]
): Promise<Map<string, RenewalDraftPricing>> {
  const map = new Map<string, RenewalDraftPricing>();
  if (parentIds.length === 0) return map;

  const { data } = await supabase
    .from("contracts")
    .select("id, parent_contract_id, start_date, end_date, total_amount, subtotal, tax_percentage, phase_start_date, seats, renewal_sequence")
    .in("parent_contract_id", parentIds)
    .neq("status", "rejected")
    .order("renewal_sequence", { ascending: false });

  for (const row of (data ?? []) as Array<RenewalDraftPricing & { parent_contract_id: string }>) {
    if (!map.has(row.parent_contract_id)) {
      map.set(row.parent_contract_id, {
        id: row.id, start_date: row.start_date, end_date: row.end_date,
        total_amount: row.total_amount, subtotal: row.subtotal, tax_percentage: row.tax_percentage,
        phase_start_date: row.phase_start_date, seats: row.seats,
      });
    }
  }
  return map;
}

// ── Day-precise rate-phase boundaries ──────────────────────────────────────
// computePhaseBoundaries etc. live in rate-phase-dates.ts (a dependency-free
// module also imported by the client-side phase editor and both PDF
// generators) so every consumer computes phase dates identically.

interface RateSegment { start: string; end: string; days: number; rate: number }

/**
 * Clips phase boundaries against [periodStart, periodEnd] (typically one
 * calendar month, already narrowed to the contract's own billable window),
 * returning one segment per phase that overlaps — 2+ segments when a phase
 * transition falls inside the period. Falls back to a single flatAmount
 * segment when no phases are configured. Periods extending past the last
 * configured phase get a flat-continuation segment at the last phase's rate.
 */
function getRateSegmentsForPeriod(
  boundaries: PhaseBoundary[],
  flatAmount: number,
  periodStart: string,
  periodEnd: string
): RateSegment[] {
  if (boundaries.length === 0) {
    return [{ start: periodStart, end: periodEnd, days: daysBetweenInclusiveYmd(periodStart, periodEnd), rate: flatAmount }];
  }

  const segments: RateSegment[] = [];
  for (const b of boundaries) {
    const segStart = b.start > periodStart ? b.start : periodStart;
    const segEnd = b.end < periodEnd ? b.end : periodEnd;
    if (segStart <= segEnd) {
      segments.push({ start: segStart, end: segEnd, days: daysBetweenInclusiveYmd(segStart, segEnd), rate: b.rate });
    }
  }

  // Period extends past the last configured phase — continue flat at its rate.
  const last = boundaries[boundaries.length - 1];
  if (periodEnd > last.end) {
    const contStart = periodStart > addDaysToYmd(last.end, 1) ? periodStart : addDaysToYmd(last.end, 1);
    if (contStart <= periodEnd) {
      segments.push({ start: contStart, end: periodEnd, days: daysBetweenInclusiveYmd(contStart, periodEnd), rate: last.rate });
    }
  }

  // Period starts before the first configured phase — shouldn't normally
  // happen (phase_start_date should anchor at/before any billed period), but
  // guard with the flat rate rather than silently dropping days.
  const first = boundaries[0];
  if (periodStart < first.start) {
    const preEnd = periodEnd < addDaysToYmd(first.start, -1) ? periodEnd : addDaysToYmd(first.start, -1);
    if (periodStart <= preEnd) {
      segments.unshift({ start: periodStart, end: preEnd, days: daysBetweenInclusiveYmd(periodStart, preEnd), rate: flatAmount });
    }
  }

  return segments;
}

/**
 * Full pipeline: phases + anchor → boundaries → segments clipped to the
 * billable window → each segment's prorated amount (rate/daysInMonth×days,
 * or the flat rate unrounded when a lone segment spans the whole month).
 */
function computeRentSegments(
  flatAmount: number,
  phaseAnchorDate: string | null | undefined,
  phases: RatePhaseDetail[] | null | undefined,
  billStartYmd: string,
  billEndYmd: string,
  prepaidDaysInMonth: number
): (RateSegment & { amount: number })[] {
  const boundaries = (phases && phases.length > 0 && phaseAnchorDate)
    ? computePhaseBoundaries(phaseAnchorDate, phases)
    : [];
  const rawSegments = getRateSegmentsForPeriod(boundaries, flatAmount, billStartYmd, billEndYmd);
  return rawSegments.map((seg) => ({
    ...seg,
    amount: seg.days >= prepaidDaysInMonth
      ? Math.round(seg.rate)
      : Math.round((seg.rate / prepaidDaysInMonth) * seg.days),
  }));
}

type RenewalSplitResult = {
  /** Own + draft segments concatenated, in date order — feed straight to buildSegmentedRentLineItems (own/draft built separately, see isRenewalSplit). */
  segments: (RateSegment & { amount: number })[];
  ownSegments: (RateSegment & { amount: number })[];
  draftSegments: (RateSegment & { amount: number })[];
  amount: number;
  taxPercentage: number;
  /** True only when the prepaid month is actually divided between the parent's own rate and the draft's rate — i.e. the parent's end_date lands mid-month. */
  isRenewalSplit: boolean;
};

/**
 * Prices one contract's rent for a single prepaid month, splitting the bill
 * between the contract's own current terms and — only for the portion of the
 * month after the parent's own end_date — a renewal draft's escalated terms.
 * Reduces to plain single-source proration when `draft` is undefined, when
 * the parent's own term still covers the whole month, or when the parent's
 * term already lapsed before the month starts (draft covers 100% of it).
 * A real gap between the parent's end_date and the draft's start_date (rare —
 * implies days nobody is contractually billable for) is left unbilled rather
 * than fabricated.
 */
export function computeRenewalSplitRentSegments(
  cid: string,
  ownStartYmd: string,
  ownEndYmd: string,
  ownSubtotal: number | null,
  ownTotalAmount: number,
  ownPhaseStartYmd: string | null,
  ownTaxPercentage: number | null,
  draft: RenewalDraftPricing | undefined,
  ratePhasesByContract: Map<string, RatePhaseDetail[]>,
  pFirstYmd: string,
  pLastYmd: string,
  prepaidDaysInMonth: number
): RenewalSplitResult {
  const ownFlatAmount = Number(ownSubtotal || ownTotalAmount);
  const ownPhaseAnchorYmd = ownPhaseStartYmd || ownStartYmd;

  let ownSegments: (RateSegment & { amount: number })[] = [];
  if (ownEndYmd >= pFirstYmd) {
    const billStart = ownStartYmd > pFirstYmd ? ownStartYmd : pFirstYmd;
    const billEnd = ownEndYmd < pLastYmd ? ownEndYmd : pLastYmd;
    if (billStart <= billEnd) {
      ownSegments = computeRentSegments(
        ownFlatAmount, ownPhaseAnchorYmd, ratePhasesByContract.get(cid) ?? null,
        billStart, billEnd, prepaidDaysInMonth
      );
    }
  }

  let draftSegments: (RateSegment & { amount: number })[] = [];
  if (draft) {
    const draftFlatAmount = Number(draft.subtotal || draft.total_amount);
    const draftPhaseAnchorYmd = draft.phase_start_date || draft.start_date;
    // Never re-bill a day already covered by the parent's own segment above.
    const afterOwnEnd = ownEndYmd >= pFirstYmd ? addDaysToYmd(ownEndYmd, 1) : pFirstYmd;
    const draftBillStart = [draft.start_date, afterOwnEnd, pFirstYmd].reduce((a, b) => (a > b ? a : b));
    const draftBillEnd = draft.end_date < pLastYmd ? draft.end_date : pLastYmd;
    if (draftBillStart <= draftBillEnd) {
      draftSegments = computeRentSegments(
        draftFlatAmount, draftPhaseAnchorYmd, ratePhasesByContract.get(draft.id) ?? null,
        draftBillStart, draftBillEnd, prepaidDaysInMonth
      );
    }
  }

  const ownDays = ownSegments.reduce((s, seg) => s + seg.days, 0);
  const draftDays = draftSegments.reduce((s, seg) => s + seg.days, 0);
  const taxPercentage = Number((draftDays > ownDays ? draft?.tax_percentage : ownTaxPercentage) || 18);

  return {
    segments: [...ownSegments, ...draftSegments],
    ownSegments,
    draftSegments,
    amount: ownSegments.reduce((s, seg) => s + seg.amount, 0) + draftSegments.reduce((s, seg) => s + seg.amount, 0),
    taxPercentage,
    isRenewalSplit: ownSegments.length > 0 && draftSegments.length > 0,
  };
}

/**
 * Builds rent line items across one or more rate segments (2+ only when a
 * phase transition splits the month). Reuses buildRentLineItems per segment
 * so multi-room space-allocation splitting still applies within each segment.
 * monthly_rate/days_used/days_in_month are only persisted when something was
 * actually prorated (a split month, or the existing contract-boundary case) —
 * an untouched full month stays a plain line item, unchanged from before.
 * `forceRangeLabel` shows each segment's date range even when there's only
 * one — used when this call covers only one side (own or draft) of a
 * renewal split-month, so a lone partial segment doesn't read as a full month.
 */
function buildSegmentedRentLineItems(
  segments: (RateSegment & { amount: number })[],
  fallbackSeats: number,
  allocations: SpaceAllocationDetail[],
  contractLocationName: string | null,
  billedMonthLabel: string,
  prepaidDaysInMonth: number,
  forceRangeLabel: boolean = false
): { description: string; qty: number; unit_price: number; amount: number; monthly_rate?: number; days_used?: number; days_in_month?: number }[] {
  const multi = segments.length > 1 || forceRangeLabel;
  const anyProration = multi || (segments.length === 1 && segments[0].days < prepaidDaysInMonth);

  const out: { description: string; qty: number; unit_price: number; amount: number; monthly_rate?: number; days_used?: number; days_in_month?: number }[] = [];
  for (const seg of segments) {
    const label = multi ? formatDateRange(seg.start, seg.end) : billedMonthLabel;
    const rawItems = buildRentLineItems(seg.amount, fallbackSeats, allocations, contractLocationName, label);
    for (const it of rawItems) {
      out.push({
        description: it.description,
        qty: it.seats,
        unit_price: it.seats ? it.amount / it.seats : it.amount,
        amount: it.amount,
        ...(anyProration ? {
          monthly_rate: it.seats ? seg.rate / it.seats : seg.rate,
          days_used: seg.days,
          days_in_month: prepaidDaysInMonth,
        } : {}),
      });
    }
  }
  return out;
}

/**
 * Splits a rent amount into one line item per allocated space unit
 * (Location/Name/Type/Seats), falling back to a single plain line when the
 * contract has no linked contract_space_allocations rows.
 *
 * `seats` on each item always reconciles to `fallbackSeats` (the contract's
 * actual billed seat count), never to the room's physical capacity — a
 * contract can bill for fewer seats than a room holds (e.g. 1 seat inside a
 * 4-seat cabin), and Qty must reflect what's billed so Qty × Rate = Amount
 * stays truthful. Room capacity is only used as a weighting proxy to split
 * seats/amount proportionally across multiple rooms.
 *
 * `contractLocationName` is used when no room is mapped, so Location still
 * shows even without a specific room; `billedMonthLabel` (e.g. "Jul26") is
 * appended to every description regardless of proration or room mapping.
 */
function buildRentLineItems(
  totalAmount: number,
  fallbackSeats: number,
  allocations: SpaceAllocationDetail[],
  contractLocationName: string | null,
  billedMonthLabel: string
): { description: string; seats: number; amount: number }[] {
  if (allocations.length === 0) {
    const seatsLabel = fallbackSeats ? `${fallbackSeats} seat${fallbackSeats > 1 ? "s" : ""}` : "";
    const description = contractLocationName
      ? `Monthly rent | Location: ${contractLocationName}${seatsLabel ? ` | ${seatsLabel}` : ""} | ${billedMonthLabel}`
      : `Monthly rent${seatsLabel ? ` (${seatsLabel})` : ""} | ${billedMonthLabel}`;
    return [{ description, seats: fallbackSeats, amount: totalAmount }];
  }

  const describe = (a: SpaceAllocationDetail, seats: number) =>
    `Monthly rent | Location: ${a.locationName ?? contractLocationName ?? "—"} | ${a.name} | ${SPACE_UNIT_TYPE_LABELS[a.type] ?? a.type} | ${seats} seat${seats > 1 ? "s" : ""} | ${billedMonthLabel}`;

  if (allocations.length === 1) {
    // Single room: attribute the contract's full billed seats to it regardless
    // of the room's own capacity.
    const a = allocations[0];
    return [{ description: describe(a, fallbackSeats), seats: fallbackSeats, amount: totalAmount }];
  }

  // Multiple rooms: split both seats and amount proportionally by each room's
  // relative capacity share (a reasonable weighting, not a claim that capacity
  // itself is what's billed).
  const capacitySum = allocations.reduce((s, a) => s + a.capacity, 0) || 1;
  const items = allocations.map((a) => {
    const share = a.capacity / capacitySum;
    const seats = Math.max(1, Math.round(fallbackSeats * share));
    return { description: describe(a, seats), seats, amount: Math.round(totalAmount * share) };
  });

  // Fix rounding drift on the last item so seats sum to fallbackSeats and
  // amount sums to exactly totalAmount.
  const seatDrift = fallbackSeats - items.reduce((s, i) => s + i.seats, 0);
  if (seatDrift !== 0) items[items.length - 1].seats = Math.max(1, items[items.length - 1].seats + seatDrift);
  const amountDrift = totalAmount - items.reduce((s, i) => s + i.amount, 0);
  if (amountDrift !== 0) items[items.length - 1].amount += amountDrift;
  // Description embeds seats, so rebuild it if drift changed the last item's seat count.
  const last = items[items.length - 1];
  const lastAlloc = allocations[allocations.length - 1];
  items[items.length - 1] = { ...last, description: describe(lastAlloc, last.seats) };

  return items;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

/** Get month name + year label, e.g. "June 2026" */
function monthLabel(month: number, year: number): string {
  return new Date(year, month - 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Get the MMMYY label for a billed month, e.g. "Jul26" — used on rent line-item descriptions. */
function monthLabelShort(month: number, year: number): string {
  return `${MONTH_ABBREVIATIONS[month - 1]}${String(year).slice(-2)}`;
}

/**
 * Customer payment due date for a statement: period_end + 7 days. The
 * /accounting/receivables page ages outstanding balances against this date
 * (not period_end), and the payment-reminder cron uses it to decide which
 * statements to nudge. 7 days matches our standard payment terms; revisit if
 * a per-contract payment_terms_days override is added later.
 */
function dueDateFromPeriodEnd(periodEndYmd: string): string {
  const [y, m, d] = periodEndYmd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 7);
  return dt.toISOString().slice(0, 10);
}

/** Due date for a rent proforma: 7 days from today (IST). Used instead of
 *  dueDateFromPeriodEnd for prepaid rent statements, whose period_end is the
 *  last day of the NEXT month — period_end + 7 would push the due date a full
 *  month too late (e.g. June 30 + 7 = July 7 instead of June 7). */
function dueDateFromSendDate(): string {
  const dt = istNow();
  dt.setUTCDate(dt.getUTCDate() + 7);
  return dt.toISOString().slice(0, 10);
}

/** Advance month by 1, wrapping year */
function nextMonth(month: number, year: number): { month: number; year: number } {
  return month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
}

/** Go back 1 month, wrapping year */
function previousMonth(month: number, year: number): { month: number; year: number } {
  return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
}

/** Longest supported advance cycle (yearly), in months. */
const MAX_BILLING_CYCLE_MONTHS = Math.max(...Object.values(BILLING_CYCLE_MONTHS));

/** One calendar month's billing window — the unit rent is always priced in. */
export interface MonthWindow {
  month: number;
  year: number;
  /** YYYY-MM-01 */
  first: string;
  /** YYYY-MM-<last day> */
  last: string;
  /** Days in this calendar month — the proration denominator. */
  days: number;
}

/**
 * The calendar months one statement covers, starting at (month, year).
 * `count` is the contract's billing-cycle length: 1 for monthly, 3 for
 * quarterly, 6 half-yearly, 12 yearly. Rent for an advance-billed cycle is
 * priced one calendar month at a time (never cycleMonths × a flat rate) so
 * rate-phase transitions, renewal splits and a contract ending mid-cycle all
 * keep working exactly as they do for a monthly contract.
 */
export function cycleMonthWindows(month: number, year: number, count: number): MonthWindow[] {
  const windows: MonthWindow[] = [];
  for (let i = 0; i < count; i++) {
    const absMonth = month - 1 + i;
    const y = year + Math.floor(absMonth / 12);
    const m = (absMonth % 12) + 1;
    const days = new Date(y, m, 0).getDate();
    windows.push({
      month: m,
      year: y,
      first: `${y}-${String(m).padStart(2, "0")}-01`,
      last: `${y}-${String(m).padStart(2, "0")}-${days}`,
      days,
    });
  }
  return windows;
}

/**
 * Build a human-readable description for a service_usage_records line item.
 * Printer services use their printer_column to produce specific labels.
 * Other services fall back to their catalog name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildServiceDescription(service?: any): string {
  // Supabase may return the joined row as an object or a single-element array
  const svc = Array.isArray(service) ? service[0] : service;
  if (svc?.printer_column === "bw")     return "Print - B/W";
  if (svc?.printer_column === "colour") return "Print - Colour";
  return svc?.name || "Service Usage";
}

/** Create or fetch the accounting period row for a given month/year. */
async function ensureAccountingPeriod(
  supabase: SupabaseClient,
  month: number,
  year: number,
): Promise<string | undefined> {
  const { data: existing } = await supabase
    .from("accounting_periods")
    .select("id")
    .eq("year", year)
    .eq("month", month)
    .maybeSingle();

  if (existing?.id) return existing.id as string;

  const { data: created } = await supabase
    .from("accounting_periods")
    .insert({ year, month, status: "open" })
    .select("id")
    .single();

  return created?.id as string | undefined;
}

/**
 * Auto-generate and dispatch rent proformas for the NEXT month.
 *
 * For each active contract:
 *   1. Quarterly gate — only run in their billing month
 *   2. Idempotency — skip if rent/combined statement already exists for next month
 *   3. Prorate if contract expires mid-next-month
 *   4. Insert + finalize statement
 *   5. Call dispatchProforma() — creates Razorpay link, PDF, sends email
 *   6. Advance quarterly next_billing_date by 3 months
 *
 * Fully automated — no human action required.
 */
export async function generateRentProformas(
  supabase: SupabaseClient,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const now = istNow();
  const targetMonth = opts.month ?? now.getMonth() + 1;
  const targetYear  = opts.year  ?? now.getFullYear();

  // Rent proformas always cover the NEXT (prepaid) month
  const prepaid            = nextMonth(targetMonth, targetYear);
  const prepaidDaysInMonth = new Date(prepaid.year, prepaid.month, 0).getDate();
  const prepaidFirstOfMonth = `${prepaid.year}-${String(prepaid.month).padStart(2, "0")}-01`;
  const prepaidLastOfMonth  = `${prepaid.year}-${String(prepaid.month).padStart(2, "0")}-${prepaidDaysInMonth}`;

  // Target month date strings (used for contract overlap query)
  const daysInTargetMonth  = new Date(targetYear, targetMonth, 0).getDate();
  const firstOfTargetMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const lastOfTargetMonth  = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${daysInTargetMonth}`;

  const periodId = await ensureAccountingPeriod(supabase, prepaid.month, prepaid.year);

  const result: GenerateResult = {
    month: targetMonth, year: targetYear,
    generated: 0, skipped: 0, errors: [],
    statementIds: [], noContact: [], notDelivered: [], cycleSkipped: [], superseded: [], alreadySent: [], supplemental: [], preview: [],
  };

  // Fetch active contracts: include any contract that starts before/during the prepaid month
  // (contracts starting in June must appear in the May billing run that generates June rent)
  let contractsQuery = supabase
    .from("contracts")
    .select(`
      id, contract_number, title, status, total_amount, subtotal, tax_percentage,
      billing_cycle, start_date, end_date, next_billing_date, seats, phase_start_date,
      location_id, lead_id, billing_mode, po_number,
      lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, state, gst_number)
    `)
    .in("status", ["active", "renewal_in_progress", "renewed"])
    .lte("start_date", prepaidLastOfMonth)
    // renewal_in_progress contracts stay billable indefinitely even after their
    // original end_date lapses — the parent keeps billing at its existing terms
    // until the renewal is activated (status flips to "renewed") or terminated.
    // "renewed" parents (early renewal) stay billable for their own remaining
    // days only — gated by end_date.gte like "active" — so a parent whose own
    // term already lapsed before the child activated doesn't get rebilled.
    .or(`status.eq.renewal_in_progress,end_date.gte.${firstOfTargetMonth}`);

  if (opts.contractId) contractsQuery = contractsQuery.eq("id", opts.contractId);
  const { data: rawContracts } = await contractsQuery;
  if (!rawContracts || rawContracts.length === 0) return result;

  // Contract-wide billing hold (00556_contract_billing_hold.sql) — a
  // deliberately separate, tolerant lookup rather than chaining onto the
  // query above: if this errors (e.g. the migration hasn't been applied to
  // this environment yet), it fails soft to "nothing is held" instead of
  // taking the whole generation run down with it, the way a hard failure in
  // the main query would (that query's own result isn't error-checked).
  const { data: heldContracts, error: heldErr } = await supabase.from("contracts").select("id").not("billing_hold_at", "is", null);
  const heldIds = new Set(heldErr ? [] : (heldContracts ?? []).map((c) => c.id));
  const contracts = rawContracts.filter((c) => !heldIds.has(c.id));
  if (contracts.length === 0) return result;

  const contractIds = contracts.map((c) => c.id as string);

  // Idempotency, partitioned by client-impact:
  //   (1) alreadySent — a covering statement was actually dispatched to the client
  //       (proforma_sent_at IS NOT NULL), or paid, or GST-issued. NEVER touch
  //       these — superseding would risk duplicate dispatch / accounting confusion.
  //   (2) supersedable — a covering combined/rent statement exists but was never
  //       sent (legacy cron drafts, unsent finalized statements). These get
  //       VOIDED so a fresh rent + usage split can replace them. The client never
  //       saw the old one, so this is a no-impact internal cleanup.
  //   (3) Neither — fresh contract, generate normally.
  //
  // Covering statements: rent|combined where either prepaid_month/year matches
  // the target prepaid month (new rows), OR statement_type=combined with
  // period_start=current target month (legacy combined rows whose prepaid is null
  // but whose line items embed next-month rent).
  const { data: coveringStmts } = await supabase
    .from("billing_statements")
    .select("id, contract_id, statement_number, prepaid_month, prepaid_year, period_start, statement_type, status, proforma_sent_at, gst_invoice_number, billing_payments:billing_payments(id)")
    .in("contract_id", contractIds)
    .in("statement_type", ["rent", "combined"])
    .is("voided_at", null)
    // A discarded draft is not a covering statement — leaving it in would put
    // it in `supersedable` and have this run void an already-thrown-away row.
    .neq("status", "discarded")
    .or(`and(prepaid_month.eq.${prepaid.month},prepaid_year.eq.${prepaid.year}),and(statement_type.eq.combined,period_start.eq.${firstOfTargetMonth},prepaid_month.is.null)`);

  const alreadySent = new Set<string>();
  const supersedable = new Map<string, { id: string; statement_number: string }>();
  for (const s of (coveringStmts || []) as Array<{
    id: string; contract_id: string; statement_number: string; status: string;
    proforma_sent_at: string | null; gst_invoice_number: string | null;
    billing_payments: { id: string }[];
  }>) {
    // A finalized/exported statement must never be superseded — it may be a GST Direct
    // statement (proforma_sent_at always null) or a PI First statement whose dispatch
    // failed but was later retried. Status is the authoritative guard here.
    const wasSentOrPaid = !!s.proforma_sent_at || !!s.gst_invoice_number || (s.billing_payments?.length ?? 0) > 0
      || s.status === "finalized" || s.status === "exported";
    if (wasSentOrPaid) {
      alreadySent.add(s.contract_id);
    } else if (!supersedable.has(s.contract_id)) {
      // Take the first (typically only) unsent covering statement to supersede
      supersedable.set(s.contract_id, { id: s.id, statement_number: s.statement_number });
    }
  }
  // If a contract has BOTH a sent statement and an unsent one, the sent one wins — drop from supersedable
  for (const cid of alreadySent) supersedable.delete(cid);

  // We need an admin client for dispatchProforma (bypasses RLS for the update step)
  const adminSupabase = createAdminClient();

  // Pre-fetch ALL contract_addons for the full billing run in one query, then
  // index by contract_id in a Map — eliminates the N+1 per-contract query that
  // was firing inside the loop below (one DB round-trip per active contract).
  // The window spans the longest possible billing cycle (yearly = 12 months
  // from the prepaid month), not just the prepaid month, because an advance
  // cycle prices every month it covers. Add-ons that aren't live in a given
  // month of the cycle price to zero for that month and are dropped there.
  const longestCycleWindows = cycleMonthWindows(prepaid.month, prepaid.year, MAX_BILLING_CYCLE_MONTHS);
  const cycleWindowLastYmd = longestCycleWindows[longestCycleWindows.length - 1].last;
  const { data: allAddonsRaw } = await adminSupabase
    .from("contract_addons")
    .select("id,description,amount,effective_from,effective_until,contract_id")
    .in("contract_id", contractIds)
    .eq("is_active", true)
    .lte("effective_from", cycleWindowLastYmd)
    .or(`effective_until.is.null,effective_until.gte.${prepaidFirstOfMonth}`);

  type AddonRow = { id: string; description: string; amount: number; effective_from: string; effective_until: string | null; contract_id: string };
  const addonsByContractId = new Map<string, AddonRow[]>();
  for (const addon of (allAddonsRaw ?? []) as AddonRow[]) {
    const list = addonsByContractId.get(addon.contract_id) ?? [];
    list.push(addon);
    addonsByContractId.set(addon.contract_id, list);
  }

  // Pre-fetch space allocations (Location/Name/Type/Seats) for rent line items
  const spaceAllocationsByContract = await fetchSpaceAllocationsByContract(adminSupabase, contractIds);
  const locationNamesByContract = await fetchLocationNamesByContract(
    adminSupabase,
    contracts as Array<{ id: string; location_id?: string | null }>
  );

  // Pre-fetch renewal drafts for renewal_in_progress parents — their escalated
  // terms supersede the parent's stale pre-renewal rate once end_date has lapsed.
  const renewalInProgressIds = (contracts as Array<{ id: string; status: string }>)
    .filter((c) => c.status === "renewal_in_progress")
    .map((c) => c.id);
  const renewalDraftByParentId = await fetchActiveRenewalDraftsByParentId(adminSupabase, renewalInProgressIds);
  const draftIds = [...renewalDraftByParentId.values()].map((d) => d.id);

  // Pre-fetch tiered rate phases, for contracts using tiered pricing
  // (includes renewal draft ids so escalated tiered contracts resolve correctly)
  const ratePhasesByContract = await fetchRatePhasesByContract(adminSupabase, [...contractIds, ...draftIds]);

  for (const contract of contracts as Array<Record<string, unknown>>) {
    const cid            = contract.id as string;
    const contractNumber = contract.contract_number as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead           = contract.lead as any;
    // Renewal draft (if any) for this renewal_in_progress parent. Its terms
    // only apply to the portion of the prepaid month after the parent's own
    // end_date — see computeRenewalSplitRentSegments for the split logic
    // (whole month at own rate, whole month at draft rate, or a genuine
    // split when the parent's end_date lands mid-month).
    const renewalDraft = contract.status === "renewal_in_progress" ? renewalDraftByParentId.get(cid) : undefined;

    try {
      // ── 1. Advance-cycle gate ───────────────────────────────────────────
      // Monthly contracts bill every run. Quarterly / half-yearly / yearly
      // contracts bill the WHOLE cycle up front, but only in the run whose
      // prepaid month contains their next_billing_date anchor — every other
      // run skips them (expected, surfaced as cycleSkipped, not an error).
      const cycleMonths = BILLING_CYCLE_MONTHS[String(contract.billing_cycle ?? "monthly")] ?? 1;
      if (cycleMonths > 1) {
        const nbd = contract.next_billing_date as string | null;
        if (!nbd || nbd < prepaidFirstOfMonth || nbd > prepaidLastOfMonth) {
          result.cycleSkipped.push(contractNumber);
          result.skipped++;
          continue;
        }
      }

      // ── 2. Idempotency partition ─────────────────────────────────────────
      //   alreadySent   → covering proforma already dispatched/paid/GST-issued → SKIP
      //   supersedable  → unsent covering combined/rent draft → VOID + replace
      //   neither       → fresh generate
      if (alreadySent.has(cid)) {
        result.alreadySent.push(contractNumber);
        result.skipped++;
        continue;
      }
      const toSupersede = supersedable.get(cid); // may be undefined

      // ── 3. Price the cycle, one calendar month at a time ─────────────────
      // A monthly contract has exactly one window (today's behaviour, byte for
      // byte). An advance-billed contract has cycleMonths windows, each priced
      // on its own days-in-month denominator so rate-phase transitions, renewal
      // splits and a contract ending mid-cycle stay correct per month. Months
      // the contract isn't billable for (it ended earlier in the cycle) price
      // to zero and contribute nothing.
      const windows = cycleMonthWindows(prepaid.month, prepaid.year, cycleMonths);
      const ownSeatQty = Number(contract.seats) || 1;
      const draftSeatQty = renewalDraft ? (Number(renewalDraft.seats) || 1) : ownSeatQty;
      const allocations = spaceAllocationsByContract.get(cid) ?? [];
      const contractLocationName = locationNamesByContract.get(cid) ?? null;
      const addons = addonsByContractId.get(cid) ?? null;

      const rentLineItems: ReturnType<typeof buildSegmentedRentLineItems> = [];
      const addonLineItems: {
        description: string; amount: number; note?: string;
        monthly_rate?: number; days_used?: number; days_in_month?: number;
      }[] = [];
      const billedWindows: MonthWindow[] = [];
      let prepaidRentAmount = 0;
      let addonsSubtotal = 0;
      let taxPercentage = Number(contract.tax_percentage || 18);
      let taxPercentageResolved = false;
      let isSplitMonth = false;
      let isProratedOrSplit = false;
      let hasRenewalSplit = false;
      // True once any month of this statement was priced on the RENEWAL's terms
      // rather than the parent's own — i.e. rent for a period that belongs to
      // the renewal contract, billed here because the renewal is not active yet.
      let billedForRenewal = false;
      let maxSegmentsInAMonth = 0;

      for (const w of windows) {
        const split = computeRenewalSplitRentSegments(
          cid,
          contract.start_date as string,
          contract.end_date as string,
          contract.subtotal as number | null,
          contract.total_amount as number,
          contract.phase_start_date as string | null,
          contract.tax_percentage as number | null,
          renewalDraft,
          ratePhasesByContract,
          w.first,
          w.last,
          w.days
        );

        if (split.amount <= 0) continue;

        // The first month that actually prices sets the statement's GST rate —
        // one rate per invoice, same as a single-month statement.
        if (!taxPercentageResolved) {
          taxPercentage = split.taxPercentage;
          taxPercentageResolved = true;
        }

        const monthShort = monthLabelShort(w.month, w.year);
        rentLineItems.push(
          ...(split.ownSegments.length > 0
            ? buildSegmentedRentLineItems(split.ownSegments, ownSeatQty, allocations, contractLocationName, monthShort, w.days, split.isRenewalSplit)
            : []),
          ...(split.draftSegments.length > 0
            ? buildSegmentedRentLineItems(split.draftSegments, draftSeatQty, allocations, contractLocationName, monthShort, w.days, split.isRenewalSplit)
            : []),
        );

        prepaidRentAmount += split.amount;
        billedWindows.push(w);
        if (split.segments.length > 1) isSplitMonth = true;
        if (split.segments.length > 1 || split.segments[0].days < w.days) isProratedOrSplit = true;
        if (split.isRenewalSplit) hasRenewalSplit = true;
        if (split.draftSegments.length > 0) billedForRenewal = true;
        maxSegmentsInAMonth = Math.max(maxSegmentsInAMonth, split.segments.length);

        // ── 4. Recurring add-ons, prorated within this month ───────────────
        // addons are pre-fetched in bulk before the loop — no per-contract DB query needed
        const wFirst = new Date(w.first + "T00:00:00Z");
        const wLast  = new Date(w.last  + "T00:00:00Z");
        for (const addon of (addons ?? [])) {
          const aFrom = new Date(addon.effective_from + "T00:00:00Z");
          const aUntil = addon.effective_until ? new Date(addon.effective_until + "T00:00:00Z") : null;
          const billStart = aFrom > wFirst ? aFrom : wFirst;
          const billEnd   = (aUntil && aUntil < wLast) ? aUntil : wLast;
          const billDays  = Math.floor((billEnd.getTime() - billStart.getTime()) / 86400000) + 1;
          // Add-on not live at all during this month of the cycle.
          if (billDays <= 0) continue;
          const isProrated = billDays < w.days;
          const addonAmt  = isProrated
            ? Math.round((addon.amount / w.days) * billDays * 100) / 100
            : addon.amount;
          addonLineItems.push({
            // Single-month statements keep the bare description they've always
            // had; a multi-month cycle needs the month or the invoice reads as
            // the same add-on charged N times for no stated reason.
            description: cycleMonths > 1 ? `${addon.description} | ${monthShort}` : addon.description,
            amount: addonAmt,
            ...(isProrated ? {
              note: `Pro-rated ${billDays}/${w.days} days`,
              monthly_rate: addon.amount,
              days_used: billDays,
              days_in_month: w.days,
            } : {}),
          });
          addonsSubtotal += addonAmt;
        }
      }

      if (prepaidRentAmount <= 0) {
        result.skipped++;
        continue;
      }

      // Period spans the first billed month through the last one actually
      // priced — a contract ending mid-cycle never claims a period past its term.
      const cycleFirstYmd = billedWindows[0].first;
      const cycleLastYmd  = billedWindows[billedWindows.length - 1].last;
      const cyclePeriodLabel = billedWindows.length > 1
        ? `${monthLabel(billedWindows[0].month, billedWindows[0].year)} – ${monthLabel(billedWindows[billedWindows.length - 1].month, billedWindows[billedWindows.length - 1].year)}`
        : monthLabel(billedWindows[0].month, billedWindows[0].year);

      const totalPrepaidSubtotal = prepaidRentAmount + addonsSubtotal;
      const { cgst: combinedCgst, sgst: combinedSgst, taxAmount: combinedTax, totalAmount: combinedTotal } = computeGstAndRounding(totalPrepaidSubtotal, taxPercentage);

      // ── Dry run: record what WOULD be billed, write/dispatch nothing ──────
      if (opts.dryRun) {
        const addonNote = addonsSubtotal > 0 ? ` + ₹${addonsSubtotal.toLocaleString("en-IN")} add-ons` : "";
        const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || undefined;
        // Build line-item breakdown for the expandable detail view
        const previewLineItems: {
          description: string; amount: number; qty?: number; unit_price?: number; note?: string;
          monthly_rate?: number; days_used?: number; days_in_month?: number;
        }[] = [
          ...rentLineItems.map((it) => ({ ...it })),
          ...addonLineItems,
        ];
        // Operators approve this preview before a live run, so an advance cycle
        // must announce itself — "3 months in advance" is the whole point of the
        // number they're about to sign off on.
        const cyclePrefix = billedWindows.length > 1
          ? `${billedWindows.length} months in advance · `
          : "";
        result.preview.push({
          contract_number: contractNumber,
          customer_name: customerName,
          type: "rent",
          period_label: cyclePeriodLabel,
          subtotal: totalPrepaidSubtotal,
          tax_amount: combinedTax,
          cgst_amount: combinedCgst,
          sgst_amount: combinedSgst,
          total_amount: combinedTotal,
          line_items: previewLineItems,
          note: hasRenewalSplit
            ? `${cyclePrefix}Split: pre-renewal rate + escalated renewal rate · CGST+SGST${addonNote}`
            : isSplitMonth
              ? `${cyclePrefix}Split across ${maxSegmentsInAMonth} rate phases · CGST+SGST${addonNote}`
              : isProratedOrSplit
                ? `${cyclePrefix}Prorated (contract ends mid-cycle) · CGST+SGST${addonNote}`
                : `${cyclePrefix}Full month · CGST+SGST${addonNote}`,
          supersedes: toSupersede?.statement_number,
        });
        result.generated++;
        continue;
      }

      // ── Live: supersede legacy unsent draft (if any) before inserting fresh ──
      // The client never saw this statement (no proforma_sent_at, no GST, no
      // payments — guards enforced when building `supersedable`). Direct void
      // update bypasses the void route's create-replacement logic; the fresh
      // rent statement BELOW is the replacement.
      if (toSupersede) {
        // Unlink charges/records/bookings so the usage generator can repick them up
        await adminSupabase.from("usage_charges").update({ billing_statement_id: null, status: "pending" }).eq("billing_statement_id", toSupersede.id);
        await adminSupabase.from("service_usage_records").update({ billing_statement_id: null, is_billed: false }).eq("billing_statement_id", toSupersede.id);
        await adminSupabase.from("bookings").update({ billing_statement_id: null }).eq("billing_statement_id", toSupersede.id);
        const { error: voidErr } = await adminSupabase
          .from("billing_statements")
          .update({
            status: "voided",
            voided_at: new Date().toISOString(),
            void_reason: "Auto-superseded by rent + usage split flow (no client impact: never sent)",
          })
          .eq("id", toSupersede.id);
        if (voidErr) {
          result.errors.push(`${contractNumber}: failed to supersede ${toSupersede.statement_number}: ${voidErr.message}`);
          continue;
        }
        result.superseded.push(toSupersede.statement_number);
      }

      // Persisted per-item (not recomputed at display time) so the PDF breakdown
      // always reflects the rate actually charged, even if the contract's rate
      // later changes (e.g. a rate-phase escalation) before the PDF is re-downloaded.
      const lineItems = [{
        type: "prepaid_rent" as const,
        label: `Prepaid Rent — ${cyclePeriodLabel}`,
        items: [...rentLineItems, ...addonLineItems],
        subtotal: totalPrepaidSubtotal,
      }];

      // ── 5. Insert statement as draft ────────────────────────────────────
      const { data: stmt, error: insertErr } = await adminSupabase
        .from("billing_statements")
        .insert({
          contract_id:         cid,
          lead_id:             contract.lead_id,
          period_start:        cycleFirstYmd,
          period_end:          cycleLastYmd,
          due_date:            dueDateFromSendDate(),
          statement_type:      "rent",
          fixed_amount:        totalPrepaidSubtotal,
          usage_amount:        0,
          service_usage_amount: 0,
          booking_usage_amount: 0,
          subtotal:            totalPrepaidSubtotal,
          tax_percentage:      taxPercentage,
          tax_amount:          combinedTax,
          total_amount:        combinedTotal,
          status:              "draft",
          accounting_period_id: periodId,
          cgst_amount:         combinedCgst,
          sgst_amount:         combinedSgst,
          igst_amount:         0,
          is_interstate:       false,
          buyer_gstin:         lead?.gst_number || null,
          place_of_supply:     "Tamil Nadu",
          po_number:           contract.po_number || null,
          line_items:          lineItems,
          prepaid_month:       prepaid.month,
          prepaid_year:        prepaid.year,
          // Attribution, not ownership: the statement stays this contract's for
          // accounting and GST, but the rent inside it is the renewal's. Without
          // it the renewal's history reads as unbilled for months it was paid for.
          billed_on_behalf_of_contract_id: billedForRenewal && renewalDraft ? renewalDraft.id : null,
        })
        .select("id")
        .single();

      if (insertErr || !stmt) {
        result.errors.push(`${contractNumber}: ${insertErr?.message ?? "Insert failed"}`);
        continue;
      }

      const stmtId = stmt.id as string;

      // ── 6. Auto-finalize ────────────────────────────────────────────────
      await adminSupabase
        .from("billing_statements")
        .update({ status: "finalized", finalized_at: new Date().toISOString() })
        .eq("id", stmtId);

      // ── 7. Dispatch (Razorpay + PDF + email) ────────────────────────────
      // GST Direct contracts skip the proforma step and issue a tax invoice immediately.
      const isGstDirect = (contract.billing_mode as string | null) === "gst_direct";
      // For GST Direct, update the due_date to period_start + 7 before dispatch
      if (isGstDirect) {
        const [py, pm, pd] = cycleFirstYmd.split("-").map(Number);
        const gstDueDate = new Date(Date.UTC(py, pm - 1, pd + 7)).toISOString().slice(0, 10);
        await adminSupabase.from("billing_statements").update({ due_date: gstDueDate }).eq("id", stmtId);
      }

      // Handoff v2 hook: when the flag is on and the contract is gst_direct,
      // skip the legacy CRM dispatch — accounts will issue the invoice in
      // Tally and upload it from /accounting/inbox. PI flow continues to
      // dispatch normally; PI handoff_state is set at payment-capture time.
      const handoff = await handleStatementFinalized(
        adminSupabase,
        stmtId,
        (contract.billing_mode as "proforma_first" | "gst_direct" | null) ?? null,
        "monthly_billing_cron",
      );

      const dispatchResult = handoff.skipLegacyDispatch
        ? { success: true, noContact: false, emailedTo: null, razorpayLinkUrl: null }
        : isGstDirect
          ? await dispatchGstDirect(adminSupabase, stmtId, null, [])
          : await dispatchProforma(adminSupabase, stmtId, null, []);

      if (dispatchResult.noContact) {
        result.noContact.push(contractNumber);
      }

      // Was the statement actually handed off? Only then may the cycle anchor
      // move — advancing past a cycle nobody was told about skips it forever.
      //
      // Two shapes of "handed off", one per billing mode:
      //   • Tally handoff v2 + gst_direct — the CRM deliberately sends nothing;
      //     routing the statement to /accounting/inbox for accounts to issue in
      //     Tally IS the delivery. The stubbed dispatchResult carries no email
      //     and no payment link, so the channel test below would read it as a
      //     failed send and pin the anchor forever — an advance-billed
      //     gst_direct contract would bill one cycle and then silently stop.
      //   • Everything else — a channel must have produced something the client
      //     can act on (an email went out, or a payment link exists).
      const delivered = handoff.skipLegacyDispatch
        ? true
        : dispatchResult.success &&
          !dispatchResult.noContact &&
          (Boolean(dispatchResult.emailedTo) || Boolean(dispatchResult.razorpayLinkUrl));

      // Raised but never reached the client (dispatch threw, Razorpay refused,
      // email bounced at send time). The statement IS finalized, so the
      // idempotency partition will treat it as already-sent and no later run
      // will retry it — that needs to be visible, not swallowed by a success
      // count. noContact is reported separately; this covers every other cause.
      if (!delivered && !dispatchResult.noContact) {
        result.notDelivered.push(contractNumber);
      }

      // ── 8. Move next_billing_date past what we just billed ──────────────
      // Derived from the period actually billed, not incremented from the old
      // value: the anchor becomes the first day of the first month NOT yet
      // billed. That makes it self-correcting — a wrong or stale anchor is
      // fixed by the next successful run instead of drifting further — and it
      // can't double-advance if a run is repeated. This generator is the ONLY
      // writer of next_billing_date; nothing downstream (statement confirm,
      // GST invoice generation) may touch it, or the anchor drifts by a month
      // per action and the advance-cycle gate starts pointing at the wrong
      // quarter. Only on confirmed delivery — a no-contact or failed dispatch
      // must not move the anchor past an unbilled cycle.
      if (delivered) {
        await adminSupabase
          .from("contracts")
          .update({ next_billing_date: addDaysToYmd(cycleLastYmd, 1) })
          .eq("id", cid);
      }

      result.generated++;
      result.statementIds.push(stmtId);

    } catch (err) {
      result.errors.push(`${contractNumber}: ${String(err)}`);
    }
    // Small inter-contract breather. Stays well under Razorpay + Resend
    // rate limits and prevents a burst of ~50 dispatches from tripping a
    // throttle. ~5s of extra wall time over a 50-contract run — negligible
    // vs the safety. Skip in dryRun (no external calls happen).
    if (!opts.dryRun) await new Promise((r) => setTimeout(r, 100));
  }

  return result;
}

/**
 * Generate DRAFT usage statements for the last FULLY-CLOSED month.
 *
 * Usage bills one level behind rent: rent is charged in advance for the
 * upcoming month, usage is charged in arrears for the month that just ended.
 * e.g. run in September, this bills August's usage — never the still-open
 * current month, so a charge logged mid-month can't be billed before the
 * month it belongs to has actually finished.
 *
 * Only created when chargeable usage exists:
 *   - Ad-hoc usage charges (status=pending, billing_statement_id IS NULL)
 *   - Facility overage records (billable_quantity > 0)
 *   - Service overage records (overage_quantity > 0)
 *   - Booking overages (paid bookings linked to contract this month)
 *
 * Statements are created as draft — admin reviews and sends via the billing page.
 * Carry-forward: charges already linked to a draft statement (billing_statement_id set)
 * are NOT picked up again. The old draft persists indefinitely until admin sends it.
 *
 * Supplemental statements: if a contract's covering statement for the period
 * was already sent/paid, but NEW ad-hoc charges or print/service overage have
 * since appeared (logged after the fact — see POST /api/usage-charges, which
 * no longer blocks this), this generates a second SUPPLEMENTAL statement
 * referencing the original via supplements_statement_id, instead of skipping
 * the contract outright. The original is never reopened or edited. Deliberately
 * limited to at most one live supplement per original (a second attempt is a
 * no-op until the first is voided) and to ad-hoc charges + print/service usage
 * only — facility_usage_records and bookings have no per-record "already
 * billed" tracking, so re-fetching them for an already-covered contract would
 * double-count whatever the original statement already included.
 */
export async function generateUsageStatements(
  supabase: SupabaseClient,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const now = istNow();
  const closedMonth = previousMonth(now.getMonth() + 1, now.getFullYear());
  const targetMonth = opts.month ?? closedMonth.month;
  const targetYear  = opts.year  ?? closedMonth.year;

  const daysInMonth  = new Date(targetYear, targetMonth, 0).getDate();
  const firstOfMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const lastOfMonth  = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${daysInMonth}`;

  const periodId = await ensureAccountingPeriod(supabase, targetMonth, targetYear);

  const result: GenerateResult = {
    month: targetMonth, year: targetYear,
    generated: 0, skipped: 0, errors: [],
    statementIds: [], noContact: [], notDelivered: [], cycleSkipped: [], superseded: [], alreadySent: [], supplemental: [], preview: [],
  };

  // Fetch active contracts
  let contractsQuery = supabase
    .from("contracts")
    .select(`
      id, contract_number, total_amount, subtotal, tax_percentage,
      billing_cycle, start_date, end_date, lead_id, po_number,
      lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, state, gst_number)
    `)
    .in("status", ["active", "renewal_in_progress", "renewed"])
    .lte("start_date", lastOfMonth)
    // renewal_in_progress contracts stay billable indefinitely even after their
    // original end_date lapses — see generateRentProformas for rationale.
    // "renewed" parents (early renewal) stay billable for their own remaining
    // days only — gated by end_date.gte like "active".
    .or(`status.eq.renewal_in_progress,end_date.gte.${firstOfMonth}`);

  if (opts.contractId) contractsQuery = contractsQuery.eq("id", opts.contractId);
  const { data: rawContracts } = await contractsQuery;
  if (!rawContracts || rawContracts.length === 0) return result;

  // Contract-wide billing hold (00556_contract_billing_hold.sql) — a
  // deliberately separate, tolerant lookup rather than chaining onto the
  // query above: if this errors (e.g. the migration hasn't been applied to
  // this environment yet), it fails soft to "nothing is held" instead of
  // taking the whole generation run down with it, the way a hard failure in
  // the main query would (that query's own result isn't error-checked). See
  // generateRentProformas for the identical pattern.
  const { data: heldContracts, error: heldErr } = await supabase.from("contracts").select("id").not("billing_hold_at", "is", null);
  const heldIds = new Set(heldErr ? [] : (heldContracts ?? []).map((c) => c.id));
  const contracts = rawContracts.filter((c) => !heldIds.has(c.id));
  if (contracts.length === 0) return result;

  const contractIds = contracts.map((c) => c.id as string);

  // Idempotency partition (same model as the rent generator):
  //   alreadySent  → covering usage/combined statement has been dispatched/paid
  //                  → SKIP, unless new usage has since appeared, in which case
  //                    generate a SUPPLEMENTAL statement instead (see below).
  //   supersedable → unsent covering combined/usage draft → VOID + replace fresh
  // Note: a covering statement for usage is type usage|combined with
  // period_start = first-of-current-month (the month whose usage we're billing).
  //
  // supplements_statement_id distinguishes an ORIGINAL covering statement from
  // a statement that is ITSELF a supplement — a supplement never blocks or
  // gets superseded by a later run; it only marks its original as already
  // topped up, so a run doesn't stack a second automatic supplement on top.
  const { data: coveringStmts } = await supabase
    .from("billing_statements")
    .select("id, contract_id, statement_number, proforma_sent_at, gst_invoice_number, supplements_statement_id, billing_payments:billing_payments(id)")
    .in("contract_id", contractIds)
    .eq("period_start", firstOfMonth)
    .in("statement_type", ["usage", "combined"])
    .is("voided_at", null)
    // A discarded draft keeps voided_at NULL (see 00432's own fix for the
    // same gap on the void/regenerate path) — exclude it explicitly so a
    // discarded supplement doesn't permanently block its original from ever
    // getting a real one.
    .neq("status", "discarded");

  const alreadySent = new Set<string>();
  const alreadySentCovering = new Map<string, { id: string; statement_number: string }>();
  const supersedable = new Map<string, { id: string; statement_number: string }>();
  const originalsWithLiveSupplement = new Set<string>();
  for (const s of (coveringStmts || []) as Array<{
    id: string; contract_id: string; statement_number: string;
    proforma_sent_at: string | null; gst_invoice_number: string | null;
    supplements_statement_id: string | null;
    billing_payments: { id: string }[];
  }>) {
    if (s.supplements_statement_id) {
      // This row is itself a supplement, not an original covering statement.
      originalsWithLiveSupplement.add(s.supplements_statement_id);
      continue;
    }
    const wasSentOrPaid = !!s.proforma_sent_at || !!s.gst_invoice_number || (s.billing_payments?.length ?? 0) > 0;
    if (wasSentOrPaid) {
      alreadySent.add(s.contract_id);
      if (!alreadySentCovering.has(s.contract_id)) alreadySentCovering.set(s.contract_id, { id: s.id, statement_number: s.statement_number });
    } else if (!supersedable.has(s.contract_id)) {
      supersedable.set(s.contract_id, { id: s.id, statement_number: s.statement_number });
    }
  }
  for (const cid of alreadySent) supersedable.delete(cid);

  // LIVE mode: void the supersedable statements BEFORE pre-fetch so the unlinked
  // usage records show up in the pre-fetch's "billing_statement_id IS NULL" filter.
  // DRYRUN: skip the void; broaden the pre-fetch instead (see filter below).
  const supersedableIds = Array.from(supersedable.values()).map(s => s.id);
  if (!opts.dryRun && supersedable.size > 0) {
    for (const [cid, info] of supersedable) {
      await supabase.from("usage_charges").update({ billing_statement_id: null, status: "pending" }).eq("billing_statement_id", info.id);
      await supabase.from("service_usage_records").update({ billing_statement_id: null, is_billed: false }).eq("billing_statement_id", info.id);
      await supabase.from("bookings").update({ billing_statement_id: null }).eq("billing_statement_id", info.id);
      const { error: voidErr } = await supabase
        .from("billing_statements")
        .update({
          status: "voided",
          voided_at: new Date().toISOString(),
          void_reason: "Auto-superseded by rent + usage split flow (no client impact: never sent)",
        })
        .eq("id", info.id);
      if (voidErr) {
        // Don't push to errors[] yet — let the per-contract loop report with contract_number
        const c = contracts.find((x) => x.id === cid) as { contract_number?: string } | undefined;
        result.errors.push(`${c?.contract_number ?? cid}: failed to supersede ${info.statement_number}: ${voidErr.message}`);
        supersedable.delete(cid); // skip generation if void failed
      } else {
        result.superseded.push(info.statement_number);
      }
    }
  }

  const billable = contractIds.filter((id) => !alreadySent.has(id));
  // Contracts eligible for a SUPPLEMENTAL statement: already sent/paid, but
  // don't already have a live (non-voided) supplement — see the "one
  // automatic supplement per original" note above the main loop below.
  const supplementable = [...alreadySent].filter(
    (cid) => !originalsWithLiveSupplement.has(alreadySentCovering.get(cid)?.id ?? "")
  );
  // Everything usageRes/serviceRes needs to check — both freshly-billable
  // contracts AND ones that might have new, still-unlinked usage worth
  // supplementing. facilityRes/bookingsRes deliberately stay scoped to
  // `billable` only — see the doc comment on generateUsageStatements for why
  // supplements can't safely include facility usage or bookings.
  const supplementCandidates = [...billable, ...supplementable];
  if (supplementCandidates.length === 0) return result;

  // Pre-fetch usage data in batch. In dryRun mode (supersede pass was a no-op),
  // also include records still linked to a supersedable statement — those would
  // BE unlinked in live mode, so the preview should reflect them as billable.
  // In live mode the supersede already ran, so those records have status=pending
  // AND billing_statement_id=null (the fresh-charges branch matches them).
  //
  // Unified filter handles both modes:
  //   (status=pending AND billing_statement_id IS NULL)  — fresh / post-supersede
  //   OR billing_statement_id IN supersedable IDs        — dryRun pre-supersede
  const usageOrFilter = supersedableIds.length > 0
    ? `and(status.eq.pending,billing_statement_id.is.null),billing_statement_id.in.(${supersedableIds.join(",")})`
    : `and(status.eq.pending,billing_statement_id.is.null)`;
  // service_usage_records uses is_billed boolean instead of a status enum
  const serviceOrFilter = supersedableIds.length > 0
    ? `and(is_billed.eq.false,billing_statement_id.is.null),billing_statement_id.in.(${supersedableIds.join(",")})`
    : `and(is_billed.eq.false,billing_statement_id.is.null)`;

  const [usageRes, facilityRes, serviceRes, bookingsRes] = await Promise.all([
    supabase
      .from("usage_charges")
      .select("id, contract_id, description, quantity, unit_price, total")
      .in("contract_id", supplementCandidates)
      .or(usageOrFilter)
      .gte("charge_date", firstOfMonth)
      .lte("charge_date", lastOfMonth),

    // Scoped to `billable` only (never supplementable contracts): this table
    // has no billing_statement_id/is_billed link (see the earlier comment
    // where it's fetched below), so there is no query-level way to tell
    // "already on the original statement" apart from "new since then" — the
    // whole period's rows always come back. Safe for a first-time contract;
    // would double-count for one that's already been billed. Facility usage
    // is therefore never supplemented in this version.
    billable.length > 0
      ? supabase
          .from("facility_usage_records")
          .select("contract_id, contract_facility_id, quantity_used, free_quota_applied, billable_quantity, unit_price, total_charge")
          .in("contract_id", billable)
          .eq("accounting_period_id", periodId ?? "")
      : Promise.resolve({ data: [], error: null }),

    supabase
      .from("service_usage_records")
      .select("id, contract_id, service_id, quantity_used, quota_snapshot, overage_quantity, overage_rate_snapshot, amount, is_billed, service:service_catalog(name, printer_column)")
      .in("contract_id", supplementCandidates)
      .eq("period_year", targetYear)
      .eq("period_month", targetMonth)
      .or(serviceOrFilter),

    // Scoped to `billable` only, same reasoning as facility_usage_records
    // above — no billing_statement_id filter is applied here, so it always
    // returns every matching booking in the period; safe only for a
    // contract that has no covering statement yet.
    billable.length > 0
      ? supabase
          .from("bookings")
          .select("id, booking_number, contract_id, space_id, booking_date, start_time, end_time, duration_hours, pricing_model, hourly_rate, total_amount, quantity, payment_status, status, space:spaces!bookings_space_id_fkey(name)")
          .in("contract_id", billable)
          .eq("customer_type", "contract_holder")
          .in("status", ["confirmed", "checked_in", "checked_out"])
          .gte("booking_date", firstOfMonth)
          .lte("booking_date", lastOfMonth)
      : Promise.resolve({ data: [], error: null }),
  ]);

  type UsageRow = { id: string; contract_id: string; description: string; quantity: number; unit_price: number; total: number };
  type FacilityRow = { contract_id: string; contract_facility_id: string; quantity_used: number; free_quota_applied: number; billable_quantity: number; unit_price: number; total_charge: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type ServiceRow = { id: string; contract_id: string; service_id: string; overage_quantity: number; overage_rate_snapshot: number; amount: number; service?: any };
  type BookingRow = { id: string; booking_number: string; contract_id: string; booking_date: string; start_time: string; end_time: string; duration_hours: number; pricing_model: string; total_amount: number; quantity: number; payment_status: string; space: { name: string }[] | { name: string } | null };

  const usageByContract    = new Map<string, UsageRow[]>();
  const facilityByContract = new Map<string, FacilityRow[]>();
  const serviceByContract  = new Map<string, ServiceRow[]>();
  const bookingsByContract = new Map<string, BookingRow[]>();

  for (const u of (usageRes.data ?? []) as UsageRow[]) {
    const list = usageByContract.get(u.contract_id) ?? [];
    list.push(u); usageByContract.set(u.contract_id, list);
  }
  for (const f of (facilityRes.data ?? []) as FacilityRow[]) {
    const list = facilityByContract.get(f.contract_id) ?? [];
    list.push(f); facilityByContract.set(f.contract_id, list);
  }
  for (const s of (serviceRes.data ?? []) as ServiceRow[]) {
    const list = serviceByContract.get(s.contract_id) ?? [];
    list.push(s); serviceByContract.set(s.contract_id, list);
  }
  for (const b of (bookingsRes.data ?? []) as BookingRow[]) {
    const list = bookingsByContract.get(b.contract_id) ?? [];
    list.push(b); bookingsByContract.set(b.contract_id, list);
  }

  for (const contract of contracts as Array<Record<string, unknown>>) {
    const cid            = contract.id as string;
    const contractNumber = contract.contract_number as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead           = contract.lead as any;

    const toSupersede = supersedable.get(cid); // already voided above in LIVE mode
    // Set only when this contract is already sent/paid for the period AND
    // doesn't already have a live supplement — the one case where new usage
    // still gets billed, as a second statement rather than a skip.
    const toSupplement = alreadySent.has(cid) ? alreadySentCovering.get(cid) : undefined;
    if (alreadySent.has(cid) && !toSupplement) {
      // Already sent/paid, and already has a live supplement covering
      // anything new — deliberately not stacking a second one automatically.
      result.alreadySent.push(contractNumber);
      result.skipped++;
      continue;
    }

    try {
      const usageCharges   = usageByContract.get(cid)    ?? [];
      const facilityRecs   = facilityByContract.get(cid) ?? [];
      const serviceRecs    = serviceByContract.get(cid)  ?? [];
      const bookings       = bookingsByContract.get(cid) ?? [];

      // Booking items — paid bookings only (free-quota rows show ₹0, skip for usage stmt)
      const bookingItems = bookings
        .filter((b) => b.payment_status !== "posted_to_bill" && b.payment_status !== "waived")
        .map((b) => {
          const spaceObj = Array.isArray(b.space) ? b.space[0] : b.space;
          const spaceName = spaceObj && typeof spaceObj === "object" && "name" in spaceObj
            ? (spaceObj as { name: string }).name : "Space";
          return {
            booking_id:     b.id,
            booking_number: b.booking_number,
            date:           b.booking_date,
            space:          spaceName,
            time:           `${b.start_time?.slice(0, 5)}–${b.end_time?.slice(0, 5)}`,
            duration:       b.pricing_model === "daily"
              ? `${Number(b.quantity || 1)} seat${Number(b.quantity || 1) > 1 ? "s" : ""}`
              : `${Number(b.duration_hours)}h`,
            amount: Number(b.total_amount || 0),
          };
        });

      const adHocSubtotal   = usageCharges.reduce((s, c) => s + Number(c.total || 0), 0);
      const facilitySubtotal = facilityRecs
        .filter((f) => Number(f.billable_quantity) > 0)
        .reduce((s, f) => s + Number(f.total_charge || 0), 0);
      const serviceSubtotal = serviceRecs
        .filter((s) => Number(s.overage_quantity) > 0)
        .reduce((s, r) => s + Number(r.amount || 0), 0);
      const bookingSubtotal = bookingItems.reduce((s, b) => s + b.amount, 0);

      const totalUsage = adHocSubtotal + facilitySubtotal + serviceSubtotal + bookingSubtotal;

      // Zero gate — skip if nothing chargeable. For a toSupplement contract
      // this is the ordinary "nothing new since the original went out" case —
      // report it the same way a never-billed contract's zero-usage month is.
      if (totalUsage <= 0 && usageCharges.length === 0 && facilityRecs.filter(f => Number(f.billable_quantity) > 0).length === 0 && serviceRecs.filter(s => Number(s.overage_quantity) > 0).length === 0) {
        if (toSupplement) result.alreadySent.push(contractNumber);
        result.skipped++;
        continue;
      }

      // GST
      const taxPercentage = Number(contract.tax_percentage || 18);
      const buyerState    = (lead?.state || "").toLowerCase().trim();
      // Place of supply is always Tamil Nadu — service rendered at TWV premises (always CGST+SGST)
      const isInterstate = false;
      const { cgst, sgst, igst, taxAmount, totalAmount } = computeGstAndRounding(totalUsage, taxPercentage);

      // ── Dry run: record what WOULD be billed, write/link nothing ─────────
      if (opts.dryRun) {
        const cats = [
          adHocSubtotal > 0 ? "ad-hoc" : null,
          facilitySubtotal > 0 ? "facility" : null,
          serviceSubtotal > 0 ? "service" : null,
          bookingSubtotal > 0 ? "bookings" : null,
        ].filter(Boolean).join(", ");
        result.preview.push({
          contract_number: contractNumber,
          customer_name: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || undefined,
          type: "usage",
          period_label: monthLabel(targetMonth, targetYear),
          subtotal: totalUsage,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          note: `${cats || "usage"} · ${isInterstate ? "IGST" : "CGST+SGST"} · draft for review${toSupplement ? " · supplemental" : ""}`,
          supersedes: toSupersede?.statement_number,
          supplements: toSupplement?.statement_number,
        });
        result.generated++;
        continue;
      }

      // Build line_items sections
      const lineItems = [
        {
          type: "booking_usage" as const,
          label: `Meeting Room Usage — ${monthLabel(targetMonth, targetYear)}`,
          items: bookingItems,
          subtotal: bookingSubtotal,
        },
        {
          type: "ad_hoc_charges" as const,
          label: `Ad-hoc Charges — ${monthLabel(targetMonth, targetYear)}`,
          items: usageCharges.map((c) => ({
            usage_charge_id: c.id, description: c.description,
            quantity: Number(c.quantity), unit_price: Number(c.unit_price), amount: Number(c.total || 0),
          })),
          subtotal: adHocSubtotal,
        },
        {
          type: "facility_usage" as const,
          label: `Facility Usage — ${monthLabel(targetMonth, targetYear)}`,
          items: facilityRecs
            .filter((f) => Number(f.billable_quantity) > 0)
            .map((f) => ({
              facility_id: f.contract_facility_id,
              qty: Number(f.billable_quantity),
              unit_price: Number(f.unit_price),
              billable: Number(f.billable_quantity),
              rate: Number(f.unit_price),
              amount: Number(f.total_charge || 0),
            })),
          subtotal: facilitySubtotal,
        },
        {
          type: "service_usage" as const,
          label: `Service Usage — ${monthLabel(targetMonth, targetYear)}`,
          items: serviceRecs
            .filter((s) => Number(s.overage_quantity) > 0)
            .map((s) => ({
              service_id: s.service_id,
              description: buildServiceDescription(s.service),
              qty: Number(s.overage_quantity),
              unit_price: Number(s.overage_rate_snapshot),
              overage: Number(s.overage_quantity),
              rate: Number(s.overage_rate_snapshot),
              amount: Number(s.amount || 0),
            })),
          subtotal: serviceSubtotal,
        },
      ].filter((s) => s.items.length > 0);

      // Insert usage statement as draft
      const { data: stmt, error: insertErr } = await supabase
        .from("billing_statements")
        .insert({
          contract_id:          cid,
          lead_id:              contract.lead_id,
          period_start:         firstOfMonth,
          period_end:           lastOfMonth,
          due_date:             dueDateFromPeriodEnd(lastOfMonth),
          statement_type:       "usage",
          fixed_amount:         0,
          usage_amount:         adHocSubtotal + facilitySubtotal,
          service_usage_amount: serviceSubtotal,
          booking_usage_amount: bookingSubtotal,
          subtotal:             totalUsage,
          tax_percentage:       taxPercentage,
          tax_amount:           taxAmount,
          total_amount:         totalAmount,
          status:               "draft",
          accounting_period_id: periodId,
          cgst_amount:          cgst,
          sgst_amount:          sgst,
          igst_amount:          igst,
          is_interstate:        isInterstate,
          buyer_gstin:          lead?.gst_number || null,
          place_of_supply:      isInterstate ? (lead?.state || "Other") : "Tamil Nadu",
          po_number:            contract.po_number || null,
          line_items:           lineItems,
          prepaid_month:        null,
          prepaid_year:         null,
          supplements_statement_id: toSupplement?.id ?? null,
        })
        .select("id")
        .single();

      if (insertErr || !stmt) {
        result.errors.push(`${contractNumber}: ${insertErr?.message ?? "Insert failed"}`);
        continue;
      }

      const stmtId = stmt.id as string;

      // Link usage charges to this statement
      if (usageCharges.length > 0) {
        await supabase
          .from("usage_charges")
          .update({ billing_statement_id: stmtId, status: "billed" })
          .in("id", usageCharges.map((c) => c.id));
      }
      // Link service usage records
      if (serviceRecs.length > 0) {
        await supabase
          .from("service_usage_records")
          .update({ billing_statement_id: stmtId, is_billed: true })
          .in("id", serviceRecs.map((s) => s.id));
      }
      // Link bookings
      const billableBookingIds = bookingItems.map((b) => b.booking_id);
      if (billableBookingIds.length > 0) {
        await supabase
          .from("bookings")
          .update({ billing_statement_id: stmtId })
          .in("id", billableBookingIds);
      }

      result.generated++;
      result.statementIds.push(stmtId);
      if (toSupplement) result.supplemental.push(contractNumber);

    } catch (err) {
      result.errors.push(`${contractNumber}: ${String(err)}`);
    }
  }

  return result;
}

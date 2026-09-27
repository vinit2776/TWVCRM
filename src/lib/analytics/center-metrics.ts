/**
 * Shared data access for the Center Analytics page (admin-only, center-wise
 * new MRR/collections/occupancy). See docs/plans/center-analytics-data-source.md
 * for the decisions behind each definition below — they are not the only
 * reasonable reading of the schema, they're the ones that were picked.
 *
 * "New MRR" (sumSalesInRange, the "sales" field/param throughout this
 * module): contracts.total_amount/subtotal ARE the monthly recurring rent
 * already, NOT a full-tenure deal value — confirmed against billing.ts
 * (never divides by tenure_months) and monthly-summary/route.ts
 * (reconstructs history as monthsElapsed * contract.total_amount). This
 * metric was originally scoped assuming total_amount was the full-tenure
 * value and labeled "Sales" on that basis; once corrected, it's really
 * "new monthly recurring rent added in the period" — relabeled "New MRR"
 * in the UI, kept as `sales` internally to avoid an unrequested rename.
 *
 * Two different notions of "when" show up here and must not be confused:
 *   - New MRR / Collections / Billed are COHORT metrics, bucketed by the
 *     date the underlying record belongs to (contract activation date,
 *     billing statement period_start) — not by when cash happened to move.
 *   - Occupancy is a SNAPSHOT metric — "as of" a single date, computed from
 *     contract_space_allocations.start_date/end_date (a contract's claim on
 *     a whole space_unit). There is no historical capacity tracking, so the
 *     capacity denominator is always current even when the occupied
 *     numerator is computed for a past date.
 */

import { z } from "zod";
import type { createClient } from "@/lib/supabase/server";
import { paymentCredit } from "@/lib/settlement";
import { computePhaseBoundaries } from "@/lib/rate-phase-dates";

type Supabase = Awaited<ReturnType<typeof createClient>>;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Today in IST as a YYYY-MM-DD anchor — matches the AR/billing convention (receivables.ts). */
export function todayIstDate(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO timestamp bounds for a YYYY-MM-DD date in IST, for filtering timestamptz columns. */
export function istDayBounds(dateStr: string): { startIso: string; endIso: string } {
  return {
    startIso: `${dateStr}T00:00:00.000+05:30`,
    endIso: `${dateStr}T23:59:59.999+05:30`,
  };
}

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const dateRangeSchema = z
  .object({ start: dateStringSchema, end: dateStringSchema })
  .refine((r) => r.start <= r.end, { message: "start must not be after end" });

export type DateRange = z.infer<typeof dateRangeSchema>;

/** Parses & validates `start`/`end` query params. Throws a message string on failure. */
export function parseDateRange(searchParams: URLSearchParams): DateRange {
  const result = dateRangeSchema.safeParse({
    start: searchParams.get("start"),
    end: searchParams.get("end"),
  });
  if (!result.success) throw result.error.issues[0]?.message ?? "Invalid date range";
  return result.data;
}

/**
 * The last `months` calendar months (IST), ending with the current month.
 * The final entry's `end` is clamped to today, so the current month reads
 * as month-to-date rather than projecting into the future.
 */
export function trailingMonthWindows(months: number): Array<{ key: string; start: string; end: string }> {
  const today = todayIstDate();
  const [ty, tm] = today.slice(0, 7).split("-").map(Number);
  const windows: Array<{ key: string; start: string; end: string }> = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth(); // 0-indexed
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    const start = `${key}-01`;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const naturalEnd = `${key}-${String(lastDay).padStart(2, "0")}`;
    const end = naturalEnd > today ? today : naturalEnd;
    windows.push({ key, start, end });
  }
  return windows;
}

// ── New MRR (contract activations) ─────────────────────────────────────────

export interface ContractRow {
  id: string;
  location_id: string;
  total_amount: number;
  activated_at: string | null;
}

/**
 * All contracts with a location, trimmed to the columns New MRR/Collections
 * need. Not range-filtered — the table is low-thousands of rows today (see
 * scoping doc), and both the summary and trend routes need to bucket this
 * same set by different windows, so one fetch + JS bucketing beats N queries.
 */
export async function fetchContracts(supabase: Supabase, locationId?: string | null): Promise<ContractRow[]> {
  // Excludes test contracts: every downstream consumer here joins a child
  // record (statement, allocation) back to this set via contract_id and
  // already skips anything that comes back unmatched (see e.g. the
  // `if (!locId) continue` pattern in the summary/trend routes), so leaving
  // a contract out of this set is enough to drop its fake billing/occupancy
  // data from every metric below.
  let q = supabase
    .from("contracts")
    .select("id, location_id, total_amount, activated_at")
    .eq("is_test_contract", false);
  if (locationId) q = q.eq("location_id", locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ContractRow[];
}

/** Sum of contracts.total_amount whose activated_at falls within [start, end] (IST). */
export function sumSalesInRange(contracts: ContractRow[], range: DateRange, locationId?: string): number {
  const { startIso } = istDayBounds(range.start);
  const { endIso } = istDayBounds(range.end);
  return contracts
    .filter((c) => (!locationId || c.location_id === locationId) && c.activated_at)
    .filter((c) => c.activated_at! >= startIso && c.activated_at! <= endIso)
    .reduce((s, c) => s + Number(c.total_amount || 0), 0);
}

// ── Collections / Billed (billing_statements + billing_payments) ─────────

export interface StatementRow {
  id: string;
  contract_id: string;
  total_amount: number;
  period_start: string;
  due_date: string | null;
  payment_status: string;
}

/**
 * Finalized/exported statements with a contract (excludes booking- and
 * proposal-linked ad-hoc statements — those aren't recurring center rent
 * billing, see scoping doc's non-goals), whose billing period starts in
 * `range`. "Billed" for a period means "statements generated for that
 * period," regardless of when the payment against them actually landed.
 *
 * billing_statements has no location_id column, so this does NOT filter by
 * location — callers join contract_id against a contracts id->location_id
 * map (from `fetchContracts`) to attribute each statement to a center.
 */
export async function fetchStatements(supabase: Supabase, range: DateRange): Promise<StatementRow[]> {
  const { data, error } = await supabase
    .from("billing_statements")
    .select("id, contract_id, total_amount, period_start, due_date, payment_status, status")
    .in("status", ["finalized", "exported"])
    .not("contract_id", "is", null)
    .gte("period_start", range.start)
    .lte("period_start", range.end);
  if (error) throw new Error(error.message);
  return (data ?? []) as StatementRow[];
}

/** Sum of paymentCredit() (amount + TDS) for payments against the given statement ids. */
export async function fetchPaymentsTotal(supabase: Supabase, statementIds: string[]): Promise<Map<string, number>> {
  const byStatement = new Map<string, number>();
  if (statementIds.length === 0) return byStatement;
  const { data, error } = await supabase
    .from("billing_payments")
    .select("billing_statement_id, amount, tds_amount")
    .in("billing_statement_id", statementIds);
  if (error) throw new Error(error.message);
  for (const p of data ?? []) {
    const sid = p.billing_statement_id as string;
    byStatement.set(sid, (byStatement.get(sid) ?? 0) + paymentCredit(p));
  }
  return byStatement;
}

// ── Occupancy (space_units + space_seat_occupants) ────────────────────────

export interface SpaceUnitRow {
  id: string;
  location_id: string;
  type: string;
  capacity: number;
}

/**
 * A contract's claim on a whole space_unit (cabin/office/desk) — NOT
 * space_seat_occupants, which despite its name is barely populated in
 * production (verified: locations with dozens of contracted cabins showed
 * 0 seat-occupant rows). contract_space_allocations is the table the
 * Locations > Spaces tab actually reads to mark a unit "Contracted" vs
 * "Vacant" (see src/app/api/locations/[id]/space-analytics/route.ts), so
 * it's the real source of truth here too.
 */
export interface SpaceAllocationRow {
  id: string;
  space_unit_id: string;
  start_date: string;
  end_date: string | null;
  contract_status: string | null;
}

export async function fetchActiveSpaceUnits(supabase: Supabase, locationId?: string | null): Promise<SpaceUnitRow[]> {
  let q = supabase.from("space_units").select("id, location_id, type, capacity").eq("is_active", true);
  if (locationId) q = q.eq("location_id", locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as SpaceUnitRow[];
}

/**
 * All allocations, any status (fetched once; "active as of a date" is
 * computed in JS via `isAllocationActiveAsOf`, same reasoning as the old
 * seat-occupant fetch: start_date/end_date IS the history).
 */
export async function fetchSpaceAllocations(supabase: Supabase, locationId?: string | null): Promise<SpaceAllocationRow[]> {
  const { data, error } = await supabase
    .from("contract_space_allocations")
    .select("id, space_unit_id, start_date, end_date, contract:contracts(status, location_id, is_test_contract)");
  if (error) throw new Error(error.message);
  type Row = { id: string; space_unit_id: string; start_date: string; end_date: string | null; contract: { status: string | null; location_id: string; is_test_contract: boolean | null } | null };
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => !r.contract?.is_test_contract);
  const filtered = locationId ? rows.filter((r) => r.contract?.location_id === locationId) : rows;
  return filtered.map((r) => ({
    id: r.id,
    space_unit_id: r.space_unit_id,
    start_date: r.start_date,
    end_date: r.end_date,
    contract_status: r.contract?.status ?? null,
  }));
}

/**
 * Active as of `asOfDate` AND the contract is currently active/renewed —
 * matches space-analytics/route.ts's definition, which guards against a
 * terminated contract's allocation row never being closed out. The
 * contract-status half is a current-only signal (no history for it), so
 * for past trend points this is an approximation: a contract active today
 * is assumed to have been legitimately active during its own past window.
 */
export function isAllocationActiveAsOf(a: SpaceAllocationRow, asOfDate: string): boolean {
  const dateOk = a.start_date <= asOfDate && (!a.end_date || a.end_date >= asOfDate);
  const contractOk = a.contract_status === "active" || a.contract_status === "renewed";
  return dateOk && contractOk;
}

/**
 * Occupied/capacity per location as of `asOfDate`, excluding business_centre
 * units — mirrors the existing dashboard occupancy widget's definition
 * (they're hourly/day-rate, not "seats"). Occupied capacity is unit-grained:
 * an allocated cabin counts its FULL capacity as occupied, not a headcount —
 * matching how contract_space_allocations actually works (a contract claims
 * a whole unit). Room-type breakdowns that want business_centre included
 * should filter `units`/`allocations` themselves rather than call this.
 */
export function computeOccupancyByLocation(
  units: SpaceUnitRow[],
  allocations: SpaceAllocationRow[],
  asOfDate: string
): Map<string, { capacity: number; occupied: number }> {
  const byLocation = new Map<string, { capacity: number; occupied: number }>();
  for (const u of units) {
    if (u.type === "business_centre") continue;
    const entry = byLocation.get(u.location_id) ?? { capacity: 0, occupied: 0 };
    entry.capacity += Number(u.capacity || 0);
    byLocation.set(u.location_id, entry);
  }
  // Built from the same business_centre-excluded set as capacity above — an
  // allocation on a business_centre unit must not count as "occupied" here
  // just because its location happens to have other, countable units.
  const unitById = new Map(units.filter((u) => u.type !== "business_centre").map((u) => [u.id, u]));
  const countedUnits = new Set<string>(); // one allocation per unit is enough to mark it occupied
  for (const a of allocations) {
    if (!isAllocationActiveAsOf(a, asOfDate)) continue;
    const unit = unitById.get(a.space_unit_id);
    if (!unit) continue; // unit is inactive or excluded (business_centre)
    if (countedUnits.has(unit.id)) continue;
    countedUnits.add(unit.id);
    const entry = byLocation.get(unit.location_id);
    if (!entry) continue;
    entry.occupied += Number(unit.capacity || 0);
  }
  for (const entry of byLocation.values()) {
    entry.occupied = Math.min(entry.occupied, entry.capacity);
  }
  return byLocation;
}

// ── Space Heat Map (per-unit occupancy % of period + current revenue) ─────

export interface SpaceUnitDetailRow extends SpaceUnitRow {
  code: string;
  name: string;
}

export async function fetchSpaceUnitsDetailed(supabase: Supabase): Promise<SpaceUnitDetailRow[]> {
  const { data, error } = await supabase
    .from("space_units")
    .select("id, location_id, type, capacity, code, name")
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return (data ?? []) as SpaceUnitDetailRow[];
}

export interface HeatmapAllocationRow {
  id: string;
  space_unit_id: string;
  contract_id: string;
  start_date: string;
  end_date: string | null;
  contract_status: string | null;
  /**
   * contracts.total_amount/subtotal ARE the monthly recurring rent already —
   * NOT a full-tenure deal value (confirmed against billing.ts, which never
   * divides by tenure_months anywhere, and monthly-summary/route.ts, which
   * reconstructs history as `monthsElapsed * contract.total_amount`). Prefer
   * subtotal (pre-tax) over total_amount, matching billing.ts's own
   * `ownFlatAmount = subtotal || total_amount` choice.
   */
  contract_monthly_flat_amount: number;
  contract_phase_anchor: string | null;
}

export interface ContractRatePhase {
  phase_order: number;
  duration_months: number;
  monthly_rate: number;
  end_date: string | null;
}

/**
 * All allocations with the contract fields the heat map needs beyond what
 * `fetchSpaceAllocations` carries — kept separate rather than widening the
 * shared row, since summary/trend/detail don't need revenue.
 */
export async function fetchSpaceAllocationsForHeatmap(supabase: Supabase): Promise<HeatmapAllocationRow[]> {
  const { data, error } = await supabase
    .from("contract_space_allocations")
    .select("id, space_unit_id, contract_id, start_date, end_date, contract:contracts(status, total_amount, subtotal, start_date, phase_start_date, is_test_contract)");
  if (error) throw new Error(error.message);
  type Row = {
    id: string; space_unit_id: string; contract_id: string; start_date: string; end_date: string | null;
    contract: { status: string | null; total_amount: number | null; subtotal: number | null; start_date: string | null; phase_start_date: string | null; is_test_contract: boolean | null } | null;
  };
  return ((data ?? []) as unknown as Row[])
    .filter((r) => !r.contract?.is_test_contract)
    .map((r) => ({
    id: r.id,
    space_unit_id: r.space_unit_id,
    contract_id: r.contract_id,
    start_date: r.start_date,
    end_date: r.end_date,
    contract_status: r.contract?.status ?? null,
    contract_monthly_flat_amount: Number(r.contract?.subtotal || r.contract?.total_amount || 0),
    contract_phase_anchor: r.contract?.phase_start_date || r.contract?.start_date || null,
  }));
}

/** contract_id -> its tiered rate phases (empty for a flat-rate contract). */
export async function fetchRatePhasesByContract(
  supabase: Supabase,
  contractIds: string[]
): Promise<Map<string, ContractRatePhase[]>> {
  const map = new Map<string, ContractRatePhase[]>();
  if (contractIds.length === 0) return map;
  const { data, error } = await supabase
    .from("contract_rate_phases")
    .select("contract_id, phase_order, duration_months, monthly_rate, end_date")
    .in("contract_id", contractIds);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<ContractRatePhase & { contract_id: string }>) {
    const list = map.get(row.contract_id) ?? [];
    list.push({ phase_order: row.phase_order, duration_months: row.duration_months, monthly_rate: Number(row.monthly_rate), end_date: row.end_date ?? null });
    map.set(row.contract_id, list);
  }
  return map;
}

/**
 * The monthly rate a contract is actually charging as of `asOfDate` — walks
 * its tiered rate_phases (see rate-phase-dates.ts, the same module billing.ts
 * uses) to find the phase covering that date, continuing flat at the last
 * phase's rate once phases run out. Falls back to the flat subtotal/
 * total_amount when the contract has no phases at all.
 */
export function currentMonthlyRate(
  flatAmount: number,
  phaseAnchor: string | null,
  phases: ContractRatePhase[] | undefined,
  asOfDate: string
): number {
  if (!phases || phases.length === 0 || !phaseAnchor) return flatAmount;
  const boundaries = computePhaseBoundaries(phaseAnchor, phases);
  const covering = boundaries.find((b) => asOfDate >= b.start && asOfDate <= b.end);
  if (covering) return covering.rate;
  const last = boundaries[boundaries.length - 1];
  // Past every configured phase — billing.ts continues flat at the last
  // phase's rate rather than reverting to the pre-phase flat amount.
  return asOfDate > last.end ? last.rate : flatAmount;
}

/** Inclusive day-overlap between an allocation's active window and [rangeStart, rangeEnd]. */
export function allocationOverlapDays(
  a: { start_date: string; end_date: string | null },
  rangeStart: string,
  rangeEnd: string
): number {
  const s = a.start_date > rangeStart ? a.start_date : rangeStart;
  const e = a.end_date && a.end_date < rangeEnd ? a.end_date : rangeEnd;
  if (s > e) return 0;
  const sMs = Date.parse(`${s}T00:00:00Z`);
  const eMs = Date.parse(`${e}T00:00:00Z`);
  return Math.round((eMs - sMs) / 86400000) + 1;
}

/** Inclusive day count of a range — e.g. Aug 1 to Aug 1 is 1 day, not 0. */
export function daysInRange(rangeStart: string, rangeEnd: string): number {
  return allocationOverlapDays({ start_date: rangeStart, end_date: rangeEnd }, rangeStart, rangeEnd);
}

function isContractLive(status: string | null): boolean {
  return status === "active" || status === "renewed";
}

export interface UnitHeatmapStats {
  unit_id: string;
  code: string;
  name: string;
  type: string;
  capacity: number;
  location_id: string;
  /** % of days in the range this unit had a live-contract allocation — a real gradient, not a snapshot. */
  occupancy_pct: number;
  /**
   * The CURRENT tenant's monthly rate (walking its rate_phases when it has
   * any, else its flat subtotal/total_amount — see currentMonthlyRate),
   * apportioned by capacity share across every unit that same contract
   * holds today. This is a snapshot (today), unlike occupancy_pct (the
   * whole range) — revenue only means something for whoever occupies the
   * unit right now, not a blend across past tenants.
   */
  monthly_revenue: number;
  vacant_now: boolean;
  /** The contract currently occupying this unit, for linking to /contracts/[id] — null when vacant. */
  contract_id: string | null;
}

/**
 * Per-unit occupancy-over-range and current revenue, for the Space Heat
 * Map. Takes the raw fetches (not fetched internally) so the route can
 * batch them alongside the locations query.
 */
export function computeUnitHeatmapStats(
  units: SpaceUnitDetailRow[],
  allocations: HeatmapAllocationRow[],
  ratePhasesByContract: Map<string, ContractRatePhase[]>,
  range: DateRange,
  todayDate: string
): UnitHeatmapStats[] {
  const totalRangeDays = daysInRange(range.start, range.end);
  const unitById = new Map(units.map((u) => [u.id, u]));

  const allocationsByUnit = new Map<string, HeatmapAllocationRow[]>();
  for (const a of allocations) {
    if (!allocationsByUnit.has(a.space_unit_id)) allocationsByUnit.set(a.space_unit_id, []);
    allocationsByUnit.get(a.space_unit_id)!.push(a);
  }

  // Group units by whichever contract currently holds them, so a multi-unit
  // contract's rate splits by seat share instead of crediting the full
  // amount to every unit it touches.
  const currentUnitIdsByContract = new Map<string, string[]>();
  for (const a of allocations) {
    if (!isContractLive(a.contract_status)) continue;
    if (!isAllocationActiveAsOf(a, todayDate)) continue;
    if (!currentUnitIdsByContract.has(a.contract_id)) currentUnitIdsByContract.set(a.contract_id, []);
    currentUnitIdsByContract.get(a.contract_id)!.push(a.space_unit_id);
  }

  return units.map((u) => {
    const unitAllocations = allocationsByUnit.get(u.id) ?? [];

    const occupiedDays = unitAllocations
      .filter((a) => isContractLive(a.contract_status))
      .reduce((sum, a) => sum + allocationOverlapDays(a, range.start, range.end), 0);
    const occupancy_pct = totalRangeDays > 0
      ? Math.round((Math.min(occupiedDays, totalRangeDays) / totalRangeDays) * 100)
      : 0;

    const currentAlloc = unitAllocations.find(
      (a) => isContractLive(a.contract_status) && isAllocationActiveAsOf(a, todayDate)
    );

    let monthly_revenue = 0;
    if (currentAlloc) {
      const siblingUnitIds = currentUnitIdsByContract.get(currentAlloc.contract_id) ?? [u.id];
      const siblingCapacity = siblingUnitIds.reduce((s, id) => s + (unitById.get(id)?.capacity ?? 0), 0);
      const rate = currentMonthlyRate(
        currentAlloc.contract_monthly_flat_amount,
        currentAlloc.contract_phase_anchor,
        ratePhasesByContract.get(currentAlloc.contract_id),
        todayDate
      );
      monthly_revenue = siblingCapacity > 0 ? rate * (u.capacity / siblingCapacity) : 0;
    }

    return {
      unit_id: u.id,
      code: u.code,
      name: u.name,
      type: u.type,
      capacity: u.capacity,
      location_id: u.location_id,
      occupancy_pct,
      monthly_revenue: Math.round(monthly_revenue),
      vacant_now: !currentAlloc,
      contract_id: currentAlloc?.contract_id ?? null,
    };
  });
}

// ── Revenue Projections (existing contracts, FY horizon, escalation-aware) ─

/**
 * A contract's start year for the Indian financial year (Apr-Mar) it falls
 * in "today" — same one-liner every other FY consumer in this codebase
 * defines locally (tds/receivable/route.ts, accounting/tds/page.tsx); kept
 * duplicated here rather than extracted, matching that precedent.
 */
export function currentFyYear(todayDate: string): number {
  const month = Number(todayDate.slice(5, 7));
  const year = Number(todayDate.slice(0, 4));
  return month >= 4 ? year : year - 1;
}

/** The 12 YYYY-MM month keys of FY `fyYear`, Apr(fyYear) through Mar(fyYear+1). */
export function fyMonths(fyYear: number): string[] {
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const y = i < 9 ? fyYear : fyYear + 1;
    const m = ((3 + i) % 12) + 1;
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return months;
}

export function fyLabel(fyYear: number): string {
  return `FY ${fyYear}–${String((fyYear + 1) % 100).padStart(2, "0")}`;
}

export interface ProjectionContractRow {
  id: string;
  contract_number: string;
  location_id: string;
  status: string;
  start_date: string;
  end_date: string | null;
  subtotal: number | null;
  total_amount: number | null;
  phase_start_date: string | null;
  escalation_percentage: number | null;
  lead_id: string;
}

/**
 * Every contract that could contribute confirmed or hypothetical-renewal
 * revenue to a projection: active/renewal_in_progress only, same live-set
 * convention as everywhere else in this module — a contract that's expired,
 * terminated, or still pre-activation contributes nothing here.
 */
export async function fetchProjectionContracts(
  supabase: Supabase,
  locationId?: string | null
): Promise<ProjectionContractRow[]> {
  let q = supabase
    .from("contracts")
    .select("id, contract_number, location_id, status, start_date, end_date, subtotal, total_amount, phase_start_date, escalation_percentage, lead_id")
    .in("status", ["active", "renewal_in_progress"])
    .eq("is_test_contract", false);
  if (locationId) q = q.eq("location_id", locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ProjectionContractRow[];
}

export interface LocationProjectionSeries {
  location_id: string;
  /** Sum of contracts overlapping that month, at their current phase rate. Stops dead at end_date. */
  confirmed: number[];
  /**
   * Incremental revenue added back for months after a contract's own
   * end_date, as if it renewed on schedule: last-charged rate x
   * (1 + escalation_percentage/100) — the same formula the real renewal
   * flow uses (contracts/[id]/renew/route.ts), applied once per contract,
   * not compounded per month. Zero for a contract still within its term.
   */
  if_renewed: number[];
}

/**
 * Monthly confirmed + hypothetical-if-renewed revenue per location across
 * the 12 months of `fyYear`. Confirmed is phase-aware (currentMonthlyRate
 * walks rate_phases same as the heat map); if_renewed applies the
 * contract's own stored escalation_percentage once, off the rate it was
 * actually charging when it ended — not the pre-phase flat amount.
 */
export function computeProjection(
  contracts: ProjectionContractRow[],
  ratePhasesByContract: Map<string, ContractRatePhase[]>,
  fyYear: number
): { months: string[]; centers: LocationProjectionSeries[] } {
  const months = fyMonths(fyYear);
  const byLocation = new Map<string, { confirmed: number[]; if_renewed: number[] }>();

  for (const c of contracts) {
    const flat = Number(c.subtotal || c.total_amount || 0);
    if (!flat) continue;
    const phases = ratePhasesByContract.get(c.id);
    const phaseAnchor = c.phase_start_date || c.start_date;
    const escPct = c.escalation_percentage != null ? Number(c.escalation_percentage) : 0;

    if (!byLocation.has(c.location_id)) {
      byLocation.set(c.location_id, { confirmed: months.map(() => 0), if_renewed: months.map(() => 0) });
    }
    const entry = byLocation.get(c.location_id)!;

    months.forEach((month, idx) => {
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-31`; // safe upper bound; months never have a 31st that matters here
      const started = c.start_date <= monthEnd;
      const notEnded = !c.end_date || c.end_date >= monthStart;
      if (started && notEnded) {
        entry.confirmed[idx] += currentMonthlyRate(flat, phaseAnchor, phases, monthStart);
      } else if (started && c.end_date && c.end_date < monthStart) {
        const rateAtEnd = currentMonthlyRate(flat, phaseAnchor, phases, c.end_date);
        entry.if_renewed[idx] += Math.round(rateAtEnd * (1 + escPct / 100));
      }
    });
  }

  const centers = Array.from(byLocation.entries()).map(([location_id, v]) => ({
    location_id,
    confirmed: v.confirmed.map(Math.round),
    if_renewed: v.if_renewed.map(Math.round),
  }));
  return { months, centers };
}

export interface ProjectionAdjustmentRow {
  id: string;
  contract_id: string;
  contract_number: string;
  location_id: string;
  month: string;
  amount: number;
  reason: string;
  created_by_name: string;
  created_at: string;
}

export async function fetchProjectionAdjustments(supabase: Supabase): Promise<ProjectionAdjustmentRow[]> {
  const { data, error } = await supabase
    .from("projection_adjustments")
    .select("id, contract_id, month, amount, reason, created_at, contract:contracts(location_id, contract_number, is_test_contract), created_by_user:users(full_name)")
    .order("month", { ascending: true });
  if (error) throw new Error(error.message);
  type Row = {
    id: string; contract_id: string; month: string; amount: number; reason: string; created_at: string;
    contract: { location_id: string; contract_number: string; is_test_contract: boolean | null } | null;
    created_by_user: { full_name: string } | null;
  };
  return ((data ?? []) as unknown as Row[])
    .filter((r) => r.contract && !r.contract.is_test_contract) // contract_id is NOT NULL FK, but defend against a race with a deleted contract
    .map((r) => ({
      id: r.id,
      contract_id: r.contract_id,
      contract_number: r.contract!.contract_number,
      location_id: r.contract!.location_id,
      month: r.month,
      amount: Number(r.amount),
      reason: r.reason,
      created_by_name: r.created_by_user?.full_name ?? "Unknown",
      created_at: r.created_at,
    }));
}

/**
 * Folds manual adjustments into a location's "confirmed" figure for whichever
 * FY the adjustment's month falls in — additive to the already-computed
 * projection, not a replacement, so an adjustment supplements a contract's
 * own start_date/rate_phases rather than needing them changed. Locations with
 * an adjustment but no other contract activity still get an entry (matching
 * computeProjection's own zero-array convention) so the amount isn't dropped.
 */
export function applyProjectionAdjustments(
  centers: LocationProjectionSeries[],
  months: string[],
  adjustments: ProjectionAdjustmentRow[]
): LocationProjectionSeries[] {
  const byLocation = new Map(centers.map((c) => [c.location_id, { ...c, confirmed: [...c.confirmed] }]));
  for (const adj of adjustments) {
    const idx = months.indexOf(adj.month);
    if (idx === -1) continue; // adjustment's month isn't in this FY horizon
    if (!byLocation.has(adj.location_id)) {
      byLocation.set(adj.location_id, {
        location_id: adj.location_id,
        confirmed: months.map(() => 0),
        if_renewed: months.map(() => 0),
      });
    }
    byLocation.get(adj.location_id)!.confirmed[idx] += adj.amount;
  }
  return Array.from(byLocation.values());
}

export interface ProjectionContractDetail {
  id: string;
  contract_number: string;
  location_id: string;
  client_name: string;
  monthly_rate: number;
  end_date: string | null;
  status: string;
  escalation_percentage: number;
  renewed_rate: number;
}

/**
 * Per-contract detail backing the "contracts ending soonest" drill-down —
 * the same rate/escalation math as computeProjection, at contract grain
 * instead of summed by month.
 */
export function buildProjectionContractDetails(
  contracts: ProjectionContractRow[],
  ratePhasesByContract: Map<string, ContractRatePhase[]>,
  clientNameByLeadId: Map<string, string>,
  todayDate: string
): ProjectionContractDetail[] {
  return contracts
    .map((c) => {
      const flat = Number(c.subtotal || c.total_amount || 0);
      const phases = ratePhasesByContract.get(c.id);
      const phaseAnchor = c.phase_start_date || c.start_date;
      const asOf = c.end_date && c.end_date < todayDate ? c.end_date : todayDate;
      const rate = Math.round(currentMonthlyRate(flat, phaseAnchor, phases, asOf));
      const escPct = c.escalation_percentage != null ? Number(c.escalation_percentage) : 0;
      return {
        id: c.id,
        contract_number: c.contract_number,
        location_id: c.location_id,
        client_name: clientNameByLeadId.get(c.lead_id) ?? "(unnamed)",
        monthly_rate: rate,
        end_date: c.end_date,
        status: c.status,
        escalation_percentage: escPct,
        renewed_rate: Math.round(rate * (1 + escPct / 100)),
      };
    })
    .sort((a, b) => (a.end_date ?? "9999-99-99").localeCompare(b.end_date ?? "9999-99-99"));
}

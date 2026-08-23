/**
 * Shared data access for the Center Analytics page (admin-only, center-wise
 * sales/collections/occupancy). See docs/plans/center-analytics-data-source.md
 * for the decisions behind each definition below — they are not the only
 * reasonable reading of the schema, they're the ones that were picked.
 *
 * Two different notions of "when" show up here and must not be confused:
 *   - Sales / Collections / Billed are COHORT metrics, bucketed by the date
 *     the underlying record belongs to (contract activation date, billing
 *     statement period_start) — not by when cash happened to move.
 *   - Occupancy is a SNAPSHOT metric — "as of" a single date, computed from
 *     space_seat_occupants.start_date/end_date. There is no historical
 *     capacity tracking, so the capacity denominator is always current even
 *     when the occupied numerator is computed for a past date.
 */

import { z } from "zod";
import type { createClient } from "@/lib/supabase/server";
import { paymentCredit } from "@/lib/settlement";

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

// ── Sales (contract activations) ──────────────────────────────────────────

export interface ContractRow {
  id: string;
  location_id: string;
  total_amount: number;
  activated_at: string | null;
}

/**
 * All contracts with a location, trimmed to the columns Sales/Collections
 * need. Not range-filtered — the table is low-thousands of rows today (see
 * scoping doc), and both the summary and trend routes need to bucket this
 * same set by different windows, so one fetch + JS bucketing beats N queries.
 */
export async function fetchContracts(supabase: Supabase, locationId?: string | null): Promise<ContractRow[]> {
  let q = supabase.from("contracts").select("id, location_id, total_amount, activated_at");
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
    .select("id, space_unit_id, start_date, end_date, contract:contracts(status, location_id)");
  if (error) throw new Error(error.message);
  type Row = { id: string; space_unit_id: string; start_date: string; end_date: string | null; contract: { status: string | null; location_id: string } | null };
  const rows = (data ?? []) as unknown as Row[];
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

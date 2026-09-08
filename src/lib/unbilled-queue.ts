/**
 * Cross-contract billing queue behind the Rentals and Usage tabs on /billing.
 * `getUnbilledQueue(supabase, type)` takes "rent" or "usage" and returns only
 * that type's rows — the two tabs each call this with their own type rather
 * than sharing one mixed list.
 *
 * Five categories, computed batched (never N+1 per contract):
 *   1. current_cycle  — this cycle's already-generated statement of the
 *                        requested type, draft/finalized, not yet sent, not
 *                        held. The routine job the old Rent/Usage tabs
 *                        existed for. For usage, "this cycle" is the last
 *                        FULLY-CLOSED month (usage bills a month behind, in
 *                        arrears — see generateUsageStatements).
 *   2. rent_gap       — rent-only: past months with no rent-bearing statement
 *                        at all, via the existing unbilledMonths() detector,
 *                        run across every contract's whole renewal chain.
 *   3. renewal_drift  — rent-only: a renewal's start date has passed/is
 *                        imminent while the child contract isn't active yet.
 *                        Same query reportRenewalDrift() uses for its email
 *                        report.
 *   4. no_renewal     — rent-only: an expired contract with zero successor
 *                        contracts, in any status.
 *   5. usage_gap      — usage-only: chargeable usage (ad-hoc charges, print
 *                        overage, facility overage) dated in a month EARLIER
 *                        than the one current_cycle is targeting. Each
 *                        generateUsageStatements run only ever looks inside
 *                        one month's window, so a charge logged late (or a
 *                        month where nobody ran "Generate Drafts") is
 *                        otherwise silently skipped by every future run —
 *                        this is what lets the admin "include it in the next
 *                        available billing cycle" per the billing model.
 *   6. supplemental   — usage-only: a contract already has a SENT/PAID usage
 *                        statement for a month, but new ad-hoc charges or
 *                        print/service overage have since appeared for that
 *                        same month. Distinct from usage_gap (nothing billed
 *                        at all yet) — here the month was billed correctly at
 *                        the time, something just turned up afterward. See
 *                        generateUsageStatements' supplemental-statement
 *                        support in billing.ts.
 *
 * Categories 2-4 are rent-specific audits (rent coverage, renewal timing);
 * categories 5-6 are the usage-specific equivalents. A type="rent" call never
 * populates usage_gap/supplemental and a type="usage" call never populates 2-4.
 *
 * Deliberately read-only: this module never writes anything. It surfaces
 * gaps for a person to act on, same philosophy as unbilledMonths() itself.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { unbilledMonths, type RentCoverage, type BillingMonth } from "@/lib/billing-months";

export type UnbilledCategory = "current_cycle" | "rent_gap" | "renewal_drift" | "no_renewal" | "usage_gap" | "supplemental";
export type UnbilledType = "rent" | "usage";

export interface UnbilledRow {
  /** Stable key: statement id for current_cycle, otherwise category:contractId:period. */
  id: string;
  category: UnbilledCategory;
  contractId: string;
  contractNumber: string;
  customerName: string;
  /** "September 2026 · current cycle" */
  periodLabel: string;
  /** Known only for current_cycle (an amount already exists to read). */
  amount: number | null;
  /** Drives "Open statement" — current_cycle rows only. */
  statementId?: string;
  /** Secondary text, e.g. "12 days late", "starts in 2 days". */
  detail?: string;
  /**
   * supplemental rows only. The month/year to pass to
   * POST /api/billing/auto-generate (mode: "usage") to generate the
   * supplemental statement — unlike rent's backfillTarget, this is the
   * period itself, not a month offset (generateUsageStatements' target
   * month IS the month being billed).
   */
  supplementTarget?: { month: number; year: number };
  /** supplemental rows only — the original statement this would top up. */
  supplementsStatementNumber?: string;
}

/** Internal-only: a YYYY-MM-DD sort key so rows sort chronologically within
 *  a category, oldest first — periodLabel is a display string and can't be
 *  sorted lexicographically ("September" < "August"). Stripped before return. */
type InternalRow = UnbilledRow & { sortKey: string };

const CATEGORY_ORDER: UnbilledCategory[] = ["current_cycle", "supplemental", "rent_gap", "renewal_drift", "no_renewal", "usage_gap"];
const STATUS_WORD: Record<UnbilledCategory, string> = {
  current_cycle: "current cycle",
  rent_gap: "gap",
  renewal_drift: "drift",
  no_renewal: "no renewal",
  usage_gap: "gap",
  supplemental: "supplemental",
};

function monthLabel(month: number, year: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
}

function periodLabel(month: number, year: number, category: UnbilledCategory): string {
  return `${monthLabel(month, year)} · ${STATUS_WORD[category]}`;
}

/** "Jul 14, 2026" — for the drift/no-renewal categories, where the relevant
 *  fact is a specific date (a start_date or end_date), not a billing month. */
function dateLabel(ymd: string, category: UnbilledCategory): string {
  const label = new Date(ymd + "T00:00:00Z").toLocaleDateString("en-IN", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  return `${label} · ${STATUS_WORD[category]}`;
}

function istTodayYmd(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The last FULLY-CLOSED calendar month (IST) — the month usage bills for.
 *  Run in September, this returns August. Mirrors generateUsageStatements'
 *  own default so the queue and the generator always agree on which month
 *  "current cycle" means for usage. */
function lastClosedMonth(): { month: number; year: number } {
  const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const cycleYear = todayIst.getUTCFullYear();
  const cycleMonth = todayIst.getUTCMonth() + 1;
  return cycleMonth === 1 ? { month: 12, year: cycleYear - 1 } : { month: cycleMonth - 1, year: cycleYear };
}

function customerNameOf(lead: { first_name?: string | null; last_name?: string | null; company?: string | null } | null | undefined): string {
  if (!lead) return "—";
  return lead.company || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "—";
}

// ─── 1. Current cycle, ready to send ────────────────────────────────────────

async function getCurrentCycleReady(supabase: SupabaseClient, type: UnbilledType): Promise<InternalRow[]> {
  const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const cycleYear = todayIst.getUTCFullYear();
  const cycleMonth = todayIst.getUTCMonth() + 1;

  // Rent's "current cycle" is the calendar month we're in right now — its
  // proforma was generated last ops-month with prepaid_month = this month
  // (see generateRentProformas). Usage bills one month behind instead: the
  // last FULLY-CLOSED month, matching generateUsageStatements' own default —
  // so a usage draft generated today (in September) covers August, not
  // September, and must be looked up by August's window, not this month's.
  const closed = lastClosedMonth();
  const windowMonth = type === "rent" ? cycleMonth : closed.month;
  const windowYear = type === "rent" ? cycleYear : closed.year;
  const firstOfCycle = `${windowYear}-${String(windowMonth).padStart(2, "0")}-01`;
  const daysInCycle = new Date(Date.UTC(windowYear, windowMonth, 0)).getUTCDate();
  const lastOfCycle = `${windowYear}-${String(windowMonth).padStart(2, "0")}-${String(daysInCycle).padStart(2, "0")}`;

  const filter = type === "rent"
    ? `and(statement_type.in.(rent,combined),prepaid_month.eq.${cycleMonth},prepaid_year.eq.${cycleYear})`
    : `and(statement_type.eq.usage,period_start.gte.${firstOfCycle},period_start.lte.${lastOfCycle})`;

  const { data, error } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_type, total_amount, prepaid_month, prepaid_year, period_start,
      contract_id, contract:contracts!billing_statements_contract_id_fkey(id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company))
    `)
    .in("status", ["draft", "finalized"])
    .is("proforma_sent_at", null)
    .is("held_at", null)
    .is("voided_at", null)
    .or(filter);

  if (error || !data) return [];

  const rows: InternalRow[] = [];
  for (const s of data as unknown as Array<{
    id: string; statement_type: string; total_amount: number | null;
    prepaid_month: number | null; prepaid_year: number | null; period_start: string;
    contract_id: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contract: any;
  }>) {
    if (!s.contract_id || !s.contract) continue;
    const isUsage = s.statement_type === "usage";
    const month = isUsage ? +s.period_start.slice(5, 7) : (s.prepaid_month ?? cycleMonth);
    const year = isUsage ? +s.period_start.slice(0, 4) : (s.prepaid_year ?? cycleYear);
    rows.push({
      id: s.id,
      category: "current_cycle",
      contractId: s.contract_id,
      contractNumber: s.contract.contract_number,
      customerName: customerNameOf(s.contract.lead),
      periodLabel: periodLabel(month, year, "current_cycle"),
      amount: s.total_amount ?? null,
      statementId: s.id,
      detail: isUsage ? "Usage statement" : "Rent statement",
      sortKey: `${year}-${String(month).padStart(2, "0")}-01`,
    });
  }
  return rows;
}

// ─── 2. Rent gap ─────────────────────────────────────────────────────────────

interface EligibleContract {
  id: string;
  contract_number: string;
  status: string;
  start_date: string;
  end_date: string;
  created_at: string;
  lead_id: string | null;
}

/** Builds each contract's renewal chain (nearest-first) from an in-memory parent map — no per-contract query. */
export function buildChain(contractId: string, parentOf: Map<string, string | null>): string[] {
  const chain = [contractId];
  const seen = new Set(chain);
  let cursor: string | null = contractId;
  for (let depth = 0; depth < 20 && cursor; depth++) {
    const parentId: string | null = parentOf.get(cursor) ?? null;
    if (!parentId || seen.has(parentId)) break;
    chain.push(parentId);
    seen.add(parentId);
    cursor = parentId;
  }
  return chain;
}

async function getRentGaps(supabase: SupabaseClient): Promise<InternalRow[]> {
  const today = istTodayYmd();

  // 1. Eligible contracts — deliberately wider than "billable now": this is
  // an audit of history, so expired/terminated contracts must be included.
  const { data: contracts } = await supabase
    .from("contracts")
    .select("id, contract_number, status, start_date, end_date, created_at, lead_id")
    .in("status", ["active", "renewal_in_progress", "renewed", "expired", "terminated"]);

  if (!contracts || contracts.length === 0) return [];
  const eligible = contracts as EligibleContract[];

  // 2. Cheap full parent map — two columns, no status filter (an ancestor may
  // be any status), one query instead of one-hop-per-contract.
  const { data: parentRows } = await supabase.from("contracts").select("id, parent_contract_id");
  const parentOf = new Map<string, string | null>((parentRows ?? []).map((r) => [r.id as string, r.parent_contract_id as string | null]));

  const chainByContract = new Map<string, string[]>();
  const allChainIds = new Set<string>();
  for (const c of eligible) {
    const chain = buildChain(c.id, parentOf);
    chainByContract.set(c.id, chain);
    for (const id of chain) allChainIds.add(id);
  }

  // 3. One statements query for every id across every chain.
  const { data: statements } = await supabase
    .from("billing_statements")
    .select("contract_id, billed_on_behalf_of_contract_id, statement_type, period_start, period_end, prepaid_month, prepaid_year, voided_at")
    .in("contract_id", [...allChainIds]);

  const statementsByContract = new Map<string, RentCoverage[]>();
  for (const s of (statements ?? []) as RentCoverage[]) {
    const list = statementsByContract.get(s.contract_id as string) ?? [];
    list.push(s);
    statementsByContract.set(s.contract_id as string, list);
  }

  // Lead names, batched.
  const leadIds = [...new Set(eligible.map((c) => c.lead_id).filter(Boolean) as string[])];
  const { data: leads } = leadIds.length
    ? await supabase.from("leads").select("id, first_name, last_name, company").in("id", leadIds)
    : { data: [] };
  const leadById = new Map((leads ?? []).map((l) => [l.id as string, l]));

  const rows: InternalRow[] = [];
  for (const c of eligible) {
    const chain = chainByContract.get(c.id) ?? [c.id];
    const chainStatements = chain.flatMap((id) => statementsByContract.get(id) ?? []);
    const missing: BillingMonth[] = unbilledMonths({
      startDate: c.start_date,
      endDate: c.end_date,
      createdAt: c.created_at,
      today,
      statements: chainStatements,
      contractId: c.id,
      contractStatus: c.status,
    });
    for (const m of missing) {
      rows.push({
        id: `rent_gap:${c.id}:${m.year}-${m.month}`,
        category: "rent_gap",
        contractId: c.id,
        contractNumber: c.contract_number,
        customerName: customerNameOf(c.lead_id ? leadById.get(c.lead_id) : null),
        periodLabel: periodLabel(m.month, m.year, "rent_gap"),
        amount: null,
        detail: "No rent statement of any kind",
        sortKey: `${m.year}-${String(m.month).padStart(2, "0")}-01`,
      });
    }
  }
  return rows;
}

// ─── 3. Renewal drift ────────────────────────────────────────────────────────

async function getRenewalDrift(supabase: SupabaseClient): Promise<InternalRow[]> {
  const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today = todayIst.toISOString().slice(0, 10);
  const horizon = new Date(todayIst.getTime() + 3 * 86400000).toISOString().slice(0, 10);

  const { data: drifting } = await supabase
    .from("contracts")
    .select("id, contract_number, status, start_date, parent_contract_id, lead_id")
    .not("parent_contract_id", "is", null)
    .not("status", "in", "(active,rejected,terminated,renewed,expired)")
    .lte("start_date", horizon)
    .order("start_date", { ascending: true });

  if (!drifting || drifting.length === 0) return [];

  const parentIds = [...new Set(drifting.map((c) => c.parent_contract_id as string))];
  const { data: parents } = await supabase.from("contracts").select("id, contract_number, end_date").in("id", parentIds);
  const parentById = new Map((parents ?? []).map((p) => [p.id as string, p]));

  const leadIds = [...new Set(drifting.map((c) => c.lead_id).filter(Boolean) as string[])];
  const { data: leads } = leadIds.length
    ? await supabase.from("leads").select("id, first_name, last_name, company").in("id", leadIds)
    : { data: [] };
  const leadById = new Map((leads ?? []).map((l) => [l.id as string, l]));

  return drifting.map((c) => {
    const parent = parentById.get(c.parent_contract_id as string);
    const startDate = c.start_date as string;
    const daysLate = Math.floor((Date.parse(today + "T00:00:00Z") - Date.parse(startDate + "T00:00:00Z")) / 86400000);
    return {
      id: `renewal_drift:${c.id}`,
      category: "renewal_drift" as const,
      contractId: c.id as string,
      contractNumber: c.contract_number as string,
      customerName: customerNameOf(c.lead_id ? leadById.get(c.lead_id) : null),
      periodLabel: dateLabel(startDate, "renewal_drift"),
      amount: null,
      detail: daysLate >= 0
        ? `${daysLate}d late — replaces ${parent?.contract_number ?? "—"} (ended ${parent?.end_date ?? "—"})`
        : `Starts in ${-daysLate}d — replaces ${parent?.contract_number ?? "—"} (ends ${parent?.end_date ?? "—"})`,
      sortKey: startDate,
    };
  });
}

// ─── 4. No renewal on file ───────────────────────────────────────────────────

async function getNoRenewalOnFile(supabase: SupabaseClient): Promise<InternalRow[]> {
  const { data: expired } = await supabase
    .from("contracts")
    .select("id, contract_number, end_date, lead_id")
    .eq("status", "expired");

  if (!expired || expired.length === 0) return [];
  const expiredIds = expired.map((c) => c.id as string);

  const { data: successors } = await supabase
    .from("contracts")
    .select("parent_contract_id")
    .in("parent_contract_id", expiredIds);
  const hasSuccessor = new Set((successors ?? []).map((s) => s.parent_contract_id as string));

  const orphaned = expired.filter((c) => !hasSuccessor.has(c.id as string));
  if (orphaned.length === 0) return [];

  const leadIds = [...new Set(orphaned.map((c) => c.lead_id).filter(Boolean) as string[])];
  const { data: leads } = leadIds.length
    ? await supabase.from("leads").select("id, first_name, last_name, company").in("id", leadIds)
    : { data: [] };
  const leadById = new Map((leads ?? []).map((l) => [l.id as string, l]));

  return orphaned.map((c) => {
    const endDate = c.end_date as string;
    return {
      id: `no_renewal:${c.id}`,
      category: "no_renewal" as const,
      contractId: c.id as string,
      contractNumber: c.contract_number as string,
      customerName: customerNameOf(c.lead_id ? leadById.get(c.lead_id) : null),
      periodLabel: dateLabel(endDate, "no_renewal"),
      amount: null,
      detail: "Zero successor contracts on file",
      sortKey: endDate,
    };
  });
}

// ─── 5. Usage gap — captured but never billed ───────────────────────────────

/** One stale-usage record's contribution to a contract/month gap bucket. */
interface GapContribution {
  contractId: string;
  monthKey: string; // "YYYY-MM"
  amount: number;
  source: string;
}

async function getUsageGaps(supabase: SupabaseClient): Promise<InternalRow[]> {
  const closed = lastClosedMonth();
  const firstOfClosedMonth = `${closed.year}-${String(closed.month).padStart(2, "0")}-01`;

  // Ad-hoc usage charges dated before the window generateUsageStatements is
  // currently targeting — a future run will only ever look inside its own
  // month's window, so these are otherwise skipped forever.
  const { data: staleCharges } = await supabase
    .from("usage_charges")
    .select("contract_id, charge_date, total")
    .eq("status", "pending")
    .is("billing_statement_id", null)
    .lt("charge_date", firstOfClosedMonth);

  // Print/service overage — same idea, keyed by period_year/period_month
  // instead of a date column.
  const { data: staleService } = await supabase
    .from("service_usage_records")
    .select("contract_id, period_year, period_month, amount, overage_quantity")
    .eq("is_billed", false)
    .is("billing_statement_id", null)
    .gt("overage_quantity", 0)
    .or(`period_year.lt.${closed.year},and(period_year.eq.${closed.year},period_month.lt.${closed.month})`);

  // Facility overage has no billing_statement_id to filter on (the table
  // predates that link — see 00012_accounting_module.sql) — detect via
  // period instead: any old period's billable usage not covered by a
  // non-voided usage/combined statement for that contract is a gap.
  const { data: oldPeriods } = await supabase
    .from("accounting_periods")
    .select("id, year, month")
    .or(`year.lt.${closed.year},and(year.eq.${closed.year},month.lt.${closed.month})`);
  const oldPeriodById = new Map(
    (oldPeriods ?? []).map((p) => [p.id as string, p as { id: string; year: number; month: number }]),
  );

  const { data: staleFacility } = oldPeriodById.size
    ? await supabase
        .from("facility_usage_records")
        .select("contract_id, accounting_period_id, billable_quantity, total_charge")
        .in("accounting_period_id", [...oldPeriodById.keys()])
        .gt("billable_quantity", 0)
    : { data: [] };

  const facilityContractIds = [...new Set((staleFacility ?? []).map((f) => f.contract_id as string))];
  const { data: coveringStatements } = facilityContractIds.length
    ? await supabase
        .from("billing_statements")
        .select("contract_id, period_start")
        .in("contract_id", facilityContractIds)
        .in("statement_type", ["usage", "combined"])
        .is("voided_at", null)
    : { data: [] };
  const covered = new Set(
    (coveringStatements ?? []).map((s) => `${s.contract_id}:${(s.period_start as string).slice(0, 7)}`),
  );

  const contributions: GapContribution[] = [];
  for (const c of (staleCharges ?? []) as Array<{ contract_id: string; charge_date: string; total: number }>) {
    contributions.push({ contractId: c.contract_id, monthKey: c.charge_date.slice(0, 7), amount: Number(c.total || 0), source: "Ad-hoc charge" });
  }
  for (const s of (staleService ?? []) as Array<{ contract_id: string; period_year: number; period_month: number; amount: number }>) {
    contributions.push({ contractId: s.contract_id, monthKey: `${s.period_year}-${String(s.period_month).padStart(2, "0")}`, amount: Number(s.amount || 0), source: "Print usage" });
  }
  for (const f of (staleFacility ?? []) as Array<{ contract_id: string; accounting_period_id: string; total_charge: number }>) {
    const period = oldPeriodById.get(f.accounting_period_id);
    if (!period) continue;
    const monthKey = `${period.year}-${String(period.month).padStart(2, "0")}`;
    if (covered.has(`${f.contract_id}:${monthKey}`)) continue; // already billed for that month
    contributions.push({ contractId: f.contract_id, monthKey, amount: Number(f.total_charge || 0), source: "Facility usage" });
  }

  if (contributions.length === 0) return [];

  // Bucket by contract + month so multiple stale records collapse into one row.
  const buckets = new Map<string, { contractId: string; monthKey: string; amount: number; sources: Set<string> }>();
  for (const c of contributions) {
    const key = `${c.contractId}:${c.monthKey}`;
    const bucket = buckets.get(key) ?? { contractId: c.contractId, monthKey: c.monthKey, amount: 0, sources: new Set<string>() };
    bucket.amount += c.amount;
    bucket.sources.add(c.source);
    buckets.set(key, bucket);
  }

  const contractIds = [...new Set([...buckets.values()].map((b) => b.contractId))];
  const { data: contracts } = contractIds.length
    ? await supabase
        .from("contracts")
        .select("id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
        .in("id", contractIds)
    : { data: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contractById = new Map((contracts ?? []).map((c: any) => [c.id as string, c]));

  const rows: InternalRow[] = [];
  for (const bucket of buckets.values()) {
    const contract = contractById.get(bucket.contractId);
    if (!contract) continue; // contract deleted/inaccessible since the usage was captured
    const [year, month] = bucket.monthKey.split("-").map(Number);
    rows.push({
      id: `usage_gap:${bucket.contractId}:${bucket.monthKey}`,
      category: "usage_gap",
      contractId: bucket.contractId,
      contractNumber: contract.contract_number,
      customerName: customerNameOf(contract.lead),
      periodLabel: periodLabel(month, year, "usage_gap"),
      amount: bucket.amount,
      detail: `${[...bucket.sources].join(", ")} — captured, not yet billed`,
      sortKey: `${bucket.monthKey}-01`,
    });
  }
  return rows;
}

// ─── 6. Supplemental — already billed, new charges found ───────────────────

async function getUsageSupplements(supabase: SupabaseClient): Promise<InternalRow[]> {
  const [{ data: pendingCharges }, { data: pendingService }] = await Promise.all([
    supabase.from("usage_charges").select("contract_id, charge_date, total").eq("status", "pending").is("billing_statement_id", null),
    supabase.from("service_usage_records").select("contract_id, period_year, period_month, amount, overage_quantity").eq("is_billed", false).is("billing_statement_id", null).gt("overage_quantity", 0),
  ]);
  if ((pendingCharges?.length ?? 0) === 0 && (pendingService?.length ?? 0) === 0) return [];

  const contractIds = [...new Set([
    ...(pendingCharges ?? []).map((c) => c.contract_id as string),
    ...(pendingService ?? []).map((s) => s.contract_id as string),
  ])];
  if (contractIds.length === 0) return [];

  // Covering statements (sent/paid, non-voided, usage/combined) for those
  // contracts, keyed by contract+month — same "wasSentOrPaid" test
  // generateUsageStatements uses for its own alreadySent partition.
  const { data: coveringStmts } = await supabase
    .from("billing_statements")
    .select("id, contract_id, statement_number, period_start, proforma_sent_at, gst_invoice_number, billing_payments:billing_payments(id)")
    .in("contract_id", contractIds)
    .in("statement_type", ["usage", "combined"])
    .is("voided_at", null);

  const coveringByKey = new Map<string, { id: string; statement_number: string }>();
  for (const s of (coveringStmts ?? []) as Array<{
    id: string; contract_id: string; statement_number: string; period_start: string;
    proforma_sent_at: string | null; gst_invoice_number: string | null;
    billing_payments: { id: string }[];
  }>) {
    const wasSentOrPaid = !!s.proforma_sent_at || !!s.gst_invoice_number || (s.billing_payments?.length ?? 0) > 0;
    if (!wasSentOrPaid) continue;
    const key = `${s.contract_id}:${s.period_start.slice(0, 7)}`;
    if (!coveringByKey.has(key)) coveringByKey.set(key, { id: s.id, statement_number: s.statement_number });
  }
  if (coveringByKey.size === 0) return [];

  // A covering statement that already has a live (non-voided) supplement
  // isn't actionable again here — generateUsageStatements only ever
  // maintains one automatic supplement per original (see its doc comment).
  const coveringIds = [...new Set([...coveringByKey.values()].map((c) => c.id))];
  const { data: existingSupplements } = await supabase
    .from("billing_statements")
    .select("supplements_statement_id")
    .in("supplements_statement_id", coveringIds)
    .is("voided_at", null);
  const alreadySupplemented = new Set((existingSupplements ?? []).map((s) => s.supplements_statement_id as string));

  const buckets = new Map<string, { contractId: string; monthKey: string; amount: number; sources: Set<string>; covering: { id: string; statement_number: string } }>();
  const addToBucket = (contractId: string, monthKey: string, amount: number, source: string) => {
    const key = `${contractId}:${monthKey}`;
    const covering = coveringByKey.get(key);
    if (!covering || alreadySupplemented.has(covering.id)) return;
    const bucket = buckets.get(key) ?? { contractId, monthKey, amount: 0, sources: new Set<string>(), covering };
    bucket.amount += amount;
    bucket.sources.add(source);
    buckets.set(key, bucket);
  };
  for (const c of (pendingCharges ?? []) as Array<{ contract_id: string; charge_date: string; total: number }>) {
    addToBucket(c.contract_id, c.charge_date.slice(0, 7), Number(c.total || 0), "Ad-hoc charge");
  }
  for (const s of (pendingService ?? []) as Array<{ contract_id: string; period_year: number; period_month: number; amount: number }>) {
    addToBucket(s.contract_id, `${s.period_year}-${String(s.period_month).padStart(2, "0")}`, Number(s.amount || 0), "Print usage");
  }
  if (buckets.size === 0) return [];

  const bucketContractIds = [...new Set([...buckets.values()].map((b) => b.contractId))];
  const { data: contracts } = await supabase
    .from("contracts")
    .select("id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
    .in("id", bucketContractIds);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contractById = new Map((contracts ?? []).map((c: any) => [c.id as string, c]));

  const rows: InternalRow[] = [];
  for (const bucket of buckets.values()) {
    const contract = contractById.get(bucket.contractId);
    if (!contract) continue;
    const [year, month] = bucket.monthKey.split("-").map(Number);
    rows.push({
      id: `supplemental:${bucket.contractId}:${bucket.monthKey}`,
      category: "supplemental",
      contractId: bucket.contractId,
      contractNumber: contract.contract_number,
      customerName: customerNameOf(contract.lead),
      periodLabel: periodLabel(month, year, "supplemental"),
      amount: bucket.amount,
      detail: `${[...bucket.sources].join(", ")} — supplements ${bucket.covering.statement_number}`,
      sortKey: `${bucket.monthKey}-01`,
      supplementTarget: { month, year },
      supplementsStatementNumber: bucket.covering.statement_number,
    });
  }
  return rows;
}

// ─── Combined ────────────────────────────────────────────────────────────────

export async function getUnbilledQueue(supabase: SupabaseClient, type: UnbilledType = "rent"): Promise<{
  rows: UnbilledRow[];
  counts: Record<UnbilledCategory, number>;
}> {
  // rent_gap / renewal_drift / no_renewal are rent-only concepts (they audit
  // rent coverage and renewal timing); usage_gap is the usage-specific
  // equivalent. Each call only runs the three queries relevant to its type
  // rather than five, four of them empty.
  const [currentCycle, rentGaps, renewalDrift, noRenewal, usageGaps, supplements] = await Promise.all([
    getCurrentCycleReady(supabase, type),
    type === "rent" ? getRentGaps(supabase) : Promise.resolve([]),
    type === "rent" ? getRenewalDrift(supabase) : Promise.resolve([]),
    type === "rent" ? getNoRenewalOnFile(supabase) : Promise.resolve([]),
    type === "usage" ? getUsageGaps(supabase) : Promise.resolve([]),
    type === "usage" ? getUsageSupplements(supabase) : Promise.resolve([]),
  ]);

  const byCategory: Record<UnbilledCategory, InternalRow[]> = {
    current_cycle: currentCycle,
    rent_gap: rentGaps,
    renewal_drift: renewalDrift,
    no_renewal: noRenewal,
    usage_gap: usageGaps,
    supplemental: supplements,
  };

  const rows = CATEGORY_ORDER.flatMap((cat) =>
    [...byCategory[cat]]
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ sortKey, ...row }) => row),
  );
  const counts = Object.fromEntries(CATEGORY_ORDER.map((cat) => [cat, byCategory[cat].length])) as Record<UnbilledCategory, number>;

  return { rows, counts };
}

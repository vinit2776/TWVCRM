/**
 * Cross-contract billing queue for the /billing page's Unbilled tab.
 *
 * Four categories, computed batched (never N+1 per contract):
 *   1. current_cycle  — this cycle's already-generated rent/usage statements,
 *                        draft/finalized, not yet sent, not held. The routine
 *                        job the old Rent/Usage tabs existed for.
 *   2. rent_gap       — past months with no rent-bearing statement at all,
 *                        via the existing unbilledMonths() detector, run
 *                        across every contract's whole renewal chain.
 *   3. renewal_drift  — a renewal's start date has passed/is imminent while
 *                        the child contract isn't active yet. Same query
 *                        reportRenewalDrift() uses for its email report.
 *   4. no_renewal     — an expired contract with zero successor contracts,
 *                        in any status.
 *
 * Deliberately read-only: this module never writes anything. It surfaces
 * gaps for a person to act on, same philosophy as unbilledMonths() itself.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { unbilledMonths, type RentCoverage, type BillingMonth } from "@/lib/billing-months";

export type UnbilledCategory = "current_cycle" | "rent_gap" | "renewal_drift" | "no_renewal";

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
}

/** Internal-only: a YYYY-MM-DD sort key so rows sort chronologically within
 *  a category, oldest first — periodLabel is a display string and can't be
 *  sorted lexicographically ("September" < "August"). Stripped before return. */
type InternalRow = UnbilledRow & { sortKey: string };

const CATEGORY_ORDER: UnbilledCategory[] = ["current_cycle", "rent_gap", "renewal_drift", "no_renewal"];
const STATUS_WORD: Record<UnbilledCategory, string> = {
  current_cycle: "current cycle",
  rent_gap: "gap",
  renewal_drift: "drift",
  no_renewal: "no renewal",
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

function customerNameOf(lead: { first_name?: string | null; last_name?: string | null; company?: string | null } | null | undefined): string {
  if (!lead) return "—";
  return lead.company || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "—";
}

// ─── 1. Current cycle, ready to send ────────────────────────────────────────

async function getCurrentCycleReady(supabase: SupabaseClient): Promise<InternalRow[]> {
  const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const cycleYear = todayIst.getUTCFullYear();
  const cycleMonth = todayIst.getUTCMonth() + 1;
  const firstOfCycle = `${cycleYear}-${String(cycleMonth).padStart(2, "0")}-01`;
  const daysInCycle = new Date(Date.UTC(cycleYear, cycleMonth, 0)).getUTCDate();
  const lastOfCycle = `${cycleYear}-${String(cycleMonth).padStart(2, "0")}-${String(daysInCycle).padStart(2, "0")}`;

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
    .or(
      `and(statement_type.in.(rent,combined),prepaid_month.eq.${cycleMonth},prepaid_year.eq.${cycleYear}),` +
      `and(statement_type.eq.usage,period_start.gte.${firstOfCycle},period_start.lte.${lastOfCycle})`,
    );

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
    .select("id, contract_number, start_date, end_date, created_at, lead_id")
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

// ─── Combined ────────────────────────────────────────────────────────────────

export async function getUnbilledQueue(supabase: SupabaseClient): Promise<{
  rows: UnbilledRow[];
  counts: Record<UnbilledCategory, number>;
}> {
  const [currentCycle, rentGaps, renewalDrift, noRenewal] = await Promise.all([
    getCurrentCycleReady(supabase),
    getRentGaps(supabase),
    getRenewalDrift(supabase),
    getNoRenewalOnFile(supabase),
  ]);

  const byCategory: Record<UnbilledCategory, InternalRow[]> = {
    current_cycle: currentCycle,
    rent_gap: rentGaps,
    renewal_drift: renewalDrift,
    no_renewal: noRenewal,
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

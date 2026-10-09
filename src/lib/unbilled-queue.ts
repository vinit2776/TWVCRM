/**
 * Cross-contract rent billing queue behind the Rentals tab on /billing.
 *
 * Four categories, computed batched (never N+1 per contract):
 *   1. current_cycle  — this cycle's already-generated rent statement,
 *                        draft/finalized, not yet sent, not held.
 *   2. rent_gap       — past months with no rent-bearing statement at all,
 *                        via the existing unbilledMonths() detector, run
 *                        across every contract's whole renewal chain.
 *   3. renewal_drift  — a renewal's start date has passed/is imminent while
 *                        the child contract isn't active yet. Same query
 *                        reportRenewalDrift() uses for its email report.
 *   4. no_renewal     — an expired contract with zero successor contracts,
 *                        in any status.
 *
 * Usage is not part of this queue: it's billed from Usage Charges → Unbilled,
 * grouped by contract and month (src/lib/usage-billing.ts).
 *
 * Deliberately read-only: this module never writes anything. It surfaces
 * gaps for a person to act on, same philosophy as unbilledMonths() itself.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { unbilledMonths, backfillableRentMonths, RENT_BACKFILL_FLOOR, type RentCoverage, type BillingMonth } from "@/lib/billing-months";
import { computeRenewalSplitRentSegments, fetchRatePhasesByContract } from "@/lib/billing";
import { computeGstAndRounding } from "@/lib/gst-math";

export type UnbilledCategory =
  | "current_cycle"
  | "current_cycle_tally"
  | "current_cycle_sent"
  | "rent_gap"
  | "renewal_drift"
  | "no_renewal";
export type UnbilledType = "rent";

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
   * Present only on rent_gap rows that may be billed directly from this list
   * — decided by backfillableRentMonths() in billing-months.ts, the same rule
   * the contract page uses (monthly contracts, June 2026 onward, statuses the
   * generator bills). Older gaps are history: an admin waives them instead.
   * Every send is previewed first.
   *
   * Carries the /api/billing/auto-generate TARGET month/year — one behind
   * the prepaid month this gap actually owes, since a rent run always bills
   * the month after the one it targets.
   */
  backfillTarget?: { month: number; year: number };
  /** rent_gap rows only: the missed prepaid month as YYYY-MM-01 — what an
   *  admin's "Waive" records (contract_rent_waivers.waived_month). */
  gapMonth?: string;
  /** rent_gap rows only: the month is before CRM rent billing began
   *  (RENT_BACKFILL_FLOOR) — the UI folds these into one bucket. */
  beforeCrmBilling?: boolean;
  /** current_cycle rows only: the statement's status, which decides how
   *  "Review & send" sends it (draft → finalize-and-send, finalized → send-proforma). */
  statementStatus?: string;
  /** rent_gap rows: the expected invoice, estimated the way the rent run would
   *  price it (rate phases, part months, add-ons, contract GST rate). `amount`
   *  carries the total. Absent when it can't be priced from the contract alone
   *  (e.g. a renewal's rate) — the Send invoice preview always has the exact figure. */
  estimate?: { subtotal: number; tax: number; taxPercentage: number; total: number };
  /** current_cycle rows: when the statement was raised on a parent for a
   *  renewal's period (billed_on_behalf_of_contract_id, 00508), the renewal's
   *  contract number — shown as "for TWV-C-…" and matched by search. */
  onBehalfOfContractNumber?: string;
  /** current_cycle_sent / current_cycle_tally rows: ISO timestamp of the send
   *  (or of the hand-off to accounts). */
  sentAt?: string;
}

/** Internal-only: a YYYY-MM-DD sort key so rows sort chronologically within
 *  a category, oldest first — periodLabel is a display string and can't be
 *  sorted lexicographically ("September" < "August"). Stripped before return. */
type InternalRow = UnbilledRow & { sortKey: string };

const CATEGORY_ORDER: UnbilledCategory[] = ["current_cycle", "current_cycle_tally", "current_cycle_sent", "rent_gap", "renewal_drift", "no_renewal"];
const STATUS_WORD: Record<UnbilledCategory, string> = {
  current_cycle: "current cycle",
  current_cycle_tally: "current cycle",
  current_cycle_sent: "current cycle",
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

// ─── 1. Current cycle ───────────────────────────────────────────────────────

/** Accounts-inbox states in which a GST Direct statement is with accounts to
 *  issue in Tally — nothing for the billing team to send (00255). */
const WITH_ACCOUNTS_HANDOFF_STATES = new Set(["direct_gst_requested", "name_check_pending", "ready_to_send"]);

export interface CurrentCycleStatement {
  status: string;
  proforma_sent_at: string | null;
  gst_invoice_sent_at: string | null;
  gst_invoice_number: string | null;
  handoff_state: string | null;
  finalized_at: string | null;
}

/**
 * Which current-cycle group a rent statement belongs to:
 *   sent  — reached the customer (proforma or GST invoice), or a GST invoice
 *           already exists for it. Shown with its date, not counted as unbilled.
 *   tally — GST Direct, handed to accounts in the Tally Inbox; the CRM
 *           deliberately sends nothing itself.
 *   ready — draft or finalized and not sent: someone needs to send it.
 *   null  — none of the above (e.g. exported without a send) — not listed.
 */
export function classifyCurrentCycleStatement(
  s: CurrentCycleStatement,
): { group: "ready" | "tally" | "sent"; at: string | null; detail: string } | null {
  if (s.proforma_sent_at) return { group: "sent", at: s.proforma_sent_at, detail: "Proforma sent" };
  if (s.gst_invoice_sent_at) return { group: "sent", at: s.gst_invoice_sent_at, detail: "GST invoice sent" };
  if (s.gst_invoice_number) return { group: "sent", at: null, detail: `GST invoice ${s.gst_invoice_number} issued` };
  if (s.handoff_state && WITH_ACCOUNTS_HANDOFF_STATES.has(s.handoff_state)) {
    return { group: "tally", at: s.finalized_at, detail: "GST Direct · with accounts" };
  }
  if (s.status === "draft") return { group: "ready", at: null, detail: "Draft · not sent" };
  if (s.status === "finalized") return { group: "ready", at: null, detail: "Finalized · never sent" };
  return null;
}

async function getCurrentCycle(supabase: SupabaseClient): Promise<{
  ready: InternalRow[]; tally: InternalRow[]; sent: InternalRow[];
}> {
  // Rent's "current cycle" is the calendar month we're in right now — its
  // proforma was generated last ops-month with prepaid_month = this month
  // (see generateRentProformas).
  const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const cycleYear = todayIst.getUTCFullYear();
  const cycleMonth = todayIst.getUTCMonth() + 1;
  const out = { ready: [] as InternalRow[], tally: [] as InternalRow[], sent: [] as InternalRow[] };

  const { data, error } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_type, status, total_amount, prepaid_month, prepaid_year,
      proforma_sent_at, gst_invoice_sent_at, gst_invoice_number, handoff_state, finalized_at,
      contract_id, contract:contracts!billing_statements_contract_id_fkey(id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)),
      on_behalf:contracts!billing_statements_billed_on_behalf_of_contract_id_fkey(contract_number)
    `)
    .in("status", ["draft", "finalized", "exported"])
    .is("held_at", null)
    .is("voided_at", null)
    .in("statement_type", ["rent", "combined"])
    .eq("prepaid_month", cycleMonth)
    .eq("prepaid_year", cycleYear);

  if (error || !data) return out;

  for (const s of data as unknown as Array<CurrentCycleStatement & {
    id: string; statement_type: string; total_amount: number | null;
    prepaid_month: number | null; prepaid_year: number | null;
    contract_id: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contract: any;
    on_behalf: { contract_number: string } | { contract_number: string }[] | null;
  }>) {
    if (!s.contract_id || !s.contract) continue;
    const cls = classifyCurrentCycleStatement(s);
    const onBehalf = Array.isArray(s.on_behalf) ? s.on_behalf[0] : s.on_behalf;
    if (!cls) continue;
    const month = s.prepaid_month ?? cycleMonth;
    const year = s.prepaid_year ?? cycleYear;
    const category: UnbilledCategory =
      cls.group === "ready" ? "current_cycle" : cls.group === "tally" ? "current_cycle_tally" : "current_cycle_sent";
    const row: InternalRow = {
      id: s.id,
      category,
      contractId: s.contract_id,
      contractNumber: s.contract.contract_number,
      customerName: customerNameOf(s.contract.lead),
      periodLabel: periodLabel(month, year, category),
      amount: s.total_amount ?? null,
      statementId: s.id,
      statementStatus: s.status,
      ...(onBehalf?.contract_number ? { onBehalfOfContractNumber: onBehalf.contract_number } : {}),
      detail: cls.detail,
      ...(cls.at ? { sentAt: cls.at } : {}),
      // Sent/handed-off rows sort newest first; ready rows keep month order.
      sortKey: cls.at ? `~${String(9e15 - new Date(cls.at).getTime()).padStart(16, "0")}` : `${year}-${String(month).padStart(2, "0")}-01`,
    };
    out[cls.group].push(row);
  }
  return out;
}

// ─── 2. Rent gap ─────────────────────────────────────────────────────────────

interface EligibleContract {
  id: string;
  contract_number: string;
  status: string;
  start_date: string;
  end_date: string;
  created_at: string;
  activated_at: string | null;
  terminated_at: string | null;
  lead_id: string | null;
  billing_cycle: string | null;
  subtotal: number | null;
  total_amount: number;
  phase_start_date: string | null;
  tax_percentage: number | null;
}

export interface GapAddon { amount: number; effective_from: string; effective_until: string | null }

/**
 * Expected rent invoice for one missed month — the same pricing the monthly
 * rent run uses: the contract's own rate (rate phases and part months via
 * computeRenewalSplitRentSegments), plus recurring add-ons pro-rated within the
 * month, plus GST at the contract's rate. Returns null when the contract's own
 * terms don't cover the month (e.g. a renewal_in_progress month past its own
 * end_date, priced at the renewal's rate) — the preview prices those.
 */
export function estimateGapRent(
  c: Pick<EligibleContract, "id" | "start_date" | "end_date" | "subtotal" | "total_amount" | "phase_start_date" | "tax_percentage">,
  m: BillingMonth,
  ratePhasesByContract: Parameters<typeof computeRenewalSplitRentSegments>[8],
  addons: GapAddon[],
): { subtotal: number; tax: number; taxPercentage: number; total: number } | null {
  const days = new Date(m.year, m.month, 0).getDate();
  const mm = String(m.month).padStart(2, "0");
  const first = `${m.year}-${mm}-01`;
  const last = `${m.year}-${mm}-${days}`;
  const split = computeRenewalSplitRentSegments(
    c.id, c.start_date, c.end_date, c.subtotal, c.total_amount, c.phase_start_date,
    c.tax_percentage, undefined, ratePhasesByContract, first, last, days,
  );
  if (split.amount <= 0) return null;

  // Add-ons: same pro-rating as generateRentProformas (days live in the month / days in month).
  const wFirst = Date.parse(first + "T00:00:00Z");
  const wLast = Date.parse(last + "T00:00:00Z");
  let addonsTotal = 0;
  for (const a of addons) {
    const from = Math.max(Date.parse(a.effective_from + "T00:00:00Z"), wFirst);
    const until = Math.min(a.effective_until ? Date.parse(a.effective_until + "T00:00:00Z") : wLast, wLast);
    const billDays = Math.floor((until - from) / 86400000) + 1;
    if (billDays <= 0) continue;
    addonsTotal += billDays < days ? Math.round((a.amount / days) * billDays * 100) / 100 : a.amount;
  }

  const subtotal = Math.round((split.amount + addonsTotal) * 100) / 100;
  const gst = computeGstAndRounding(subtotal, split.taxPercentage);
  return { subtotal, tax: gst.taxAmount, taxPercentage: split.taxPercentage, total: gst.totalAmount };
}

/** Converts a PREPAID month (what's actually owed, e.g. September) into the
 *  auto-generate API's TARGET month (September's proforma is raised by a run
 *  whose target is August) — a rent run always bills the month after the one
 *  it targets. Mirrors prepaidToApiTarget in contract-invoices-section.tsx. */
function prepaidToApiTarget(m: BillingMonth): { month: number; year: number } {
  return m.month === 1 ? { month: 12, year: m.year - 1 } : { month: m.month - 1, year: m.year };
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

/**
 * One-line reason shown on a rent-gap row, so a row without "Send invoice"
 * says why. Order matters: the first matching reason wins.
 */
export function rentGapReason(opts: {
  backfillable: boolean;
  beforeCrmBilling: boolean;
  status: string;
  billingCycle: string | null;
  isCurrentMonth: boolean;
}): string {
  if (opts.backfillable) return opts.isCurrentMonth ? "Missed month-end run" : "No rent invoice raised";
  if (opts.beforeCrmBilling) return "Before CRM billing — waive if billed outside";
  if (opts.status === "terminated") return "Contract terminated";
  if (opts.status === "expired") return "Contract expired";
  if (opts.billingCycle && opts.billingCycle !== "monthly") return "Advance-billed contract — check its cycle on the contract page";
  return "No rent invoice — check the contract";
}

async function getRentGaps(supabase: SupabaseClient): Promise<InternalRow[]> {
  const today = istTodayYmd();

  // 1. Eligible contracts — deliberately wider than "billable now": this is
  // an audit of history, so expired/terminated contracts must be included.
  const { data: contracts } = await supabase
    .from("contracts")
    .select("id, contract_number, status, start_date, end_date, created_at, activated_at, terminated_at, lead_id, billing_cycle, subtotal, total_amount, phase_start_date, tax_percentage")
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

  // Live (un-revoked) admin waivers — a waived month is handled, not a gap.
  const { data: waivers } = await supabase
    .from("contract_rent_waivers")
    .select("contract_id, waived_month")
    .in("contract_id", eligible.map((c) => c.id))
    .is("revoked_at", null);
  const waivedByContract = new Map<string, string[]>();
  for (const w of waivers ?? []) {
    const list = waivedByContract.get(w.contract_id as string) ?? [];
    list.push(w.waived_month as string);
    waivedByContract.set(w.contract_id as string, list);
  }

  const currentYm = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };

  // Pricing inputs for the expected-amount estimate, batched (no N+1).
  const eligibleIds = eligible.map((c) => c.id);
  const ratePhasesByContract = await fetchRatePhasesByContract(supabase, eligibleIds);
  const { data: addonRows } = await supabase
    .from("contract_addons")
    .select("contract_id, amount, effective_from, effective_until")
    .in("contract_id", eligibleIds)
    .eq("is_active", true);
  const addonsByContract = new Map<string, GapAddon[]>();
  for (const a of addonRows ?? []) {
    const list = addonsByContract.get(a.contract_id as string) ?? [];
    list.push({ amount: Number(a.amount), effective_from: a.effective_from as string, effective_until: (a.effective_until as string | null) ?? null });
    addonsByContract.set(a.contract_id as string, list);
  }

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
      waivedMonths: waivedByContract.get(c.id),
      terminatedAt: c.terminated_at,
      activatedAt: c.activated_at,
    });
    // Same rule the contract page uses, so the two can never disagree about
    // which gaps can be raised directly (see backfillableRentMonths).
    const backfillableKeys = new Set(
      backfillableRentMonths({ missed: missing, billingCycle: c.billing_cycle, contractStatus: c.status, endDate: c.end_date })
        .map((m) => m.year * 12 + m.month),
    );

    for (const m of missing) {
      const backfillable = backfillableKeys.has(m.year * 12 + m.month);
      const beforeCrmBilling = m.year * 12 + m.month < RENT_BACKFILL_FLOOR.year * 12 + RENT_BACKFILL_FLOOR.month;
      const estimate = estimateGapRent(c, m, ratePhasesByContract, addonsByContract.get(c.id) ?? []);
      rows.push({
        id: `rent_gap:${c.id}:${m.year}-${m.month}`,
        category: "rent_gap",
        contractId: c.id,
        contractNumber: c.contract_number,
        customerName: customerNameOf(c.lead_id ? leadById.get(c.lead_id) : null),
        periodLabel: periodLabel(m.month, m.year, "rent_gap"),
        amount: estimate?.total ?? null,
        ...(estimate ? { estimate } : {}),
        detail: rentGapReason({
          backfillable, beforeCrmBilling, status: c.status, billingCycle: c.billing_cycle,
          isCurrentMonth: m.year === currentYm.year && m.month === currentYm.month,
        }),
        ...(beforeCrmBilling ? { beforeCrmBilling: true } : {}),
        sortKey: `${m.year}-${String(m.month).padStart(2, "0")}-01`,
        gapMonth: `${m.year}-${String(m.month).padStart(2, "0")}-01`,
        ...(backfillable ? { backfillTarget: prepaidToApiTarget(m) } : {}),
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
    getCurrentCycle(supabase),
    getRentGaps(supabase),
    getRenewalDrift(supabase),
    getNoRenewalOnFile(supabase),
  ]);

  const byCategory: Record<UnbilledCategory, InternalRow[]> = {
    current_cycle: currentCycle.ready,
    current_cycle_tally: currentCycle.tally,
    current_cycle_sent: currentCycle.sent,
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

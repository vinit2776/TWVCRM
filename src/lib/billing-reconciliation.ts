/**
 * Billing Reconciliation report — data assembly.
 *
 * One row per contract that's currently billable (or was recently and still
 * has money outstanding), one cell per month in a rolling window starting
 * this month. Built for /accounting/billing-reconciliation and its .xlsx
 * export — both call buildBillingReconciliationReport() so the numbers in
 * the browser and the download can never drift apart.
 *
 * Row lifecycle (confirmed against the mock before this was built):
 *   - status IN (active, renewal_in_progress) — always shown.
 *   - status IN (terminated, renewed) — shown only while a finalized,
 *     non-voided statement in the display window is still unpaid/partially
 *     paid; dropped the reporting cycle after that balance settles. An old
 *     unresolved balance from OUTSIDE this window (terminated/renewed long
 *     ago, still unpaid) intentionally does not resurrect the row — that's
 *     what Receivables (AR) is for. `expired` contracts are out of scope for
 *     now; the resolution logic below generalizes cleanly to them later if
 *     that's ever asked for.
 *
 * Per-month cell resolution order (see resolveCell):
 *   1. Past the row's own cutoff month (end_date for active/renewal_in_progress/
 *      renewed rows, terminated_at for terminated rows) →
 *        "renewed_out" (status was renewed and a child contract exists),
 *        "terminated" (status was terminated),
 *        or "projected" (still active, no successor yet — beyond-tenure
 *        escalation estimate).
 *   2. Before the row's own start_date → "not_started" (only ever hit by a
 *      freshly created renewal child before its term begins).
 *   3. An approved moratorium covers this month → "moratorium".
 *   4. A real, finalized, non-voided statement covers this month → "paid" /
 *      "partial" / "unpaid", using computeSettlement() — the one shared
 *      definition of "paid" in this codebase — rather than trusting the
 *      statement's own (informal, not always fresh) payment_status column.
 *   5. Otherwise "future" — rent not yet billed, computed via the exact same
 *      rate-phase-aware pure function (computeRenewalSplitRentSegments) the
 *      real generator uses, so the projection matches what production
 *      billing will eventually produce for that month.
 *
 * Known v1 limitation: "future" and "projected" amounts are the rent line
 * only (contract_addons proration is inline in generateRentProformas and not
 * extracted into a reusable function). Real (already-billed) months are
 * unaffected — they read the statement's actual total_amount as-is.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeRenewalSplitRentSegments,
  fetchRatePhasesByContract,
  cycleMonthWindows,
} from "@/lib/billing";
import { computeGstAndRounding } from "@/lib/gst-math";
import { computeSettlement, type SettlementPayment } from "@/lib/settlement";
import { leadName } from "@/lib/invoice-party";
import { todayIst } from "@/lib/receivables";

const BILLABLE_STATUSES = ["active", "renewal_in_progress"] as const;
const LIFECYCLE_CARRYOVER_STATUSES = ["terminated", "renewed"] as const;

export type ReconciliationCellType =
  | "paid"
  | "partial"
  | "unpaid"
  | "future"
  | "projected"
  | "moratorium"
  | "terminated"
  | "renewed_out"
  | "not_started";

export interface ReconciliationCell {
  type: ReconciliationCellType;
  amount: number;
  collected: number;
  owed: number;
  invoiceNumber: string | null;
  statementId: string | null;
  reason: string | null;
  refContractId: string | null;
  refContractNumber: string | null;
}

export interface ReconciliationContractRow {
  id: string;
  contractNumber: string;
  status: string;
  companyName: string;
  locationId: string;
  locationName: string;
  startDate: string;
  endDate: string;
  terminatedAt: string | null;
  escalationPercentage: number | null;
  isRenewal: boolean;
  renewedAt: string | null;
  parentContractId: string | null;
  parentContractNumber: string | null;
  cells: ReconciliationCell[];
  rowTotalAmount: number;
  rowTotalOwed: number;
}

export interface MonthColumn {
  month: number;
  year: number;
  first: string;
  last: string;
}

interface MonthlyTotal {
  amount: number;
  owed: number;
}

export interface ReconciliationGroup {
  locationId: string;
  locationName: string;
  contracts: ReconciliationContractRow[];
  monthlyTotals: MonthlyTotal[];
  totalAmount: number;
  totalOwed: number;
}

export interface ReconciliationReport {
  months: MonthColumn[];
  groups: ReconciliationGroup[];
  overall: { monthlyTotals: MonthlyTotal[]; totalAmount: number; totalOwed: number };
}

const emptyCell = (type: ReconciliationCellType): ReconciliationCell => ({
  type,
  amount: 0,
  collected: 0,
  owed: 0,
  invoiceNumber: null,
  statementId: null,
  reason: null,
  refContractId: null,
  refContractNumber: null,
});

const monthKey = (ymd: string) => ymd.slice(0, 7);

interface ContractRow {
  id: string;
  contract_number: string;
  status: string;
  lead_id: string;
  location_id: string | null;
  subtotal: number;
  total_amount: number;
  tax_percentage: number | null;
  phase_start_date: string | null;
  start_date: string;
  end_date: string;
  escalation_percentage: number | null;
  parent_contract_id: string | null;
  is_renewal: boolean | null;
  renewed_at: string | null;
  terminated_at: string | null;
  lead: { id: string; first_name: string | null; last_name: string | null; company: string | null } | null;
  location: { id: string; name: string } | null;
}

const CONTRACT_SELECT = `
  id, contract_number, status, lead_id, location_id, subtotal, total_amount,
  tax_percentage, phase_start_date, start_date, end_date, escalation_percentage,
  parent_contract_id, is_renewal, renewed_at, terminated_at,
  lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company),
  location:locations!contracts_location_id_fkey(id, name)
`;

export async function buildBillingReconciliationReport(
  supabase: SupabaseClient,
  opts: { months?: number } = {}
): Promise<ReconciliationReport> {
  const monthCount = opts.months ?? 12;
  const today = todayIst();
  const startMonth = Number(today.slice(5, 7));
  const startYear = Number(today.slice(0, 4));
  const months: MonthColumn[] = cycleMonthWindows(startMonth, startYear, monthCount);
  const windowFirst = months[0].first;
  const windowLast = months[months.length - 1].last;

  // ── 1. Base row set: currently billable contracts ────────────────────────
  const { data: baseContracts } = await supabase
    .from("contracts")
    .select(CONTRACT_SELECT)
    .in("status", BILLABLE_STATUSES);

  // ── 2. Terminated/renewed contracts that still owe money in-window ───────
  const { data: unsettled } = await supabase
    .from("billing_statements")
    .select("contract_id")
    .in("status", ["finalized", "exported"])
    .in("payment_status", ["unpaid", "partially_paid"])
    .is("voided_at", null)
    .gte("period_start", windowFirst)
    .lte("period_start", windowLast)
    .not("contract_id", "is", null);
  const unsettledContractIds = [...new Set((unsettled ?? []).map((r) => r.contract_id as string))];

  let carryoverContracts: ContractRow[] = [];
  if (unsettledContractIds.length > 0) {
    const { data } = await supabase
      .from("contracts")
      .select(CONTRACT_SELECT)
      .in("status", LIFECYCLE_CARRYOVER_STATUSES)
      .in("id", unsettledContractIds);
    carryoverContracts = (data ?? []) as unknown as ContractRow[];
  }

  const contracts = [...((baseContracts ?? []) as unknown as ContractRow[]), ...carryoverContracts];
  const contractIds = contracts.map((c) => c.id);
  if (contractIds.length === 0) {
    return { months, groups: [], overall: { monthlyTotals: months.map(() => ({ amount: 0, owed: 0 })), totalAmount: 0, totalOwed: 0 } };
  }

  // ── 3. Everything the per-month resolver needs, batched (no N+1) ─────────
  const ratePhasesByContract = await fetchRatePhasesByContract(supabase, contractIds);

  interface StatementRow {
    id: string;
    contract_id: string;
    period_start: string;
    total_amount: number;
    gst_invoice_number: string | null;
    statement_number: string | null;
  }

  const { data: statements } = await supabase
    .from("billing_statements")
    .select("id, contract_id, period_start, total_amount, gst_invoice_number, statement_number")
    .in("contract_id", contractIds)
    .in("status", ["finalized", "exported"])
    .is("voided_at", null)
    .gte("period_start", windowFirst)
    .lte("period_start", windowLast)
    .returns<StatementRow[]>();

  const statementsByContractMonth = new Map<string, Map<string, StatementRow>>();
  for (const s of statements ?? []) {
    const cid = s.contract_id;
    const key = monthKey(s.period_start);
    if (!statementsByContractMonth.has(cid)) statementsByContractMonth.set(cid, new Map());
    statementsByContractMonth.get(cid)!.set(key, s);
  }

  const statementIds = (statements ?? []).map((s) => s.id as string);
  const paymentsByStatement = new Map<string, SettlementPayment[]>();
  if (statementIds.length > 0) {
    const { data: payments } = await supabase
      .from("billing_payments")
      .select("billing_statement_id, amount, tds_amount")
      .in("billing_statement_id", statementIds);
    for (const p of payments ?? []) {
      const sid = p.billing_statement_id as string;
      if (!paymentsByStatement.has(sid)) paymentsByStatement.set(sid, []);
      paymentsByStatement.get(sid)!.push({ amount: p.amount, tds_amount: p.tds_amount });
    }
  }

  const { data: moratoriums } = await supabase
    .from("contract_billing_moratoriums")
    .select("contract_id, moratorium_month, reason")
    .in("contract_id", contractIds)
    .eq("status", "approved")
    .gte("moratorium_month", windowFirst)
    .lte("moratorium_month", windowLast);
  const moratoriumByContractMonth = new Map<string, Map<string, string>>();
  for (const m of moratoriums ?? []) {
    const cid = m.contract_id as string;
    const key = monthKey(m.moratorium_month as string);
    if (!moratoriumByContractMonth.has(cid)) moratoriumByContractMonth.set(cid, new Map());
    moratoriumByContractMonth.get(cid)!.set(key, m.reason as string);
  }

  const renewedIds = contracts.filter((c) => c.status === "renewed").map((c) => c.id);
  const childByParentId = new Map<string, { id: string; contract_number: string }>();
  if (renewedIds.length > 0) {
    const { data: children } = await supabase
      .from("contracts")
      .select("id, contract_number, parent_contract_id, renewal_sequence")
      .in("parent_contract_id", renewedIds)
      .order("renewal_sequence", { ascending: false });
    for (const child of children ?? []) {
      const parentId = child.parent_contract_id as string;
      if (!childByParentId.has(parentId)) {
        childByParentId.set(parentId, { id: child.id as string, contract_number: child.contract_number as string });
      }
    }
  }

  const parentIds = [...new Set(contracts.filter((c) => c.is_renewal && c.parent_contract_id).map((c) => c.parent_contract_id as string))];
  const parentById = new Map<string, { id: string; contract_number: string }>();
  if (parentIds.length > 0) {
    const { data: parents } = await supabase.from("contracts").select("id, contract_number").in("id", parentIds);
    for (const p of parents ?? []) parentById.set(p.id as string, { id: p.id as string, contract_number: p.contract_number as string });
  }

  // ── 4. Resolve every cell ─────────────────────────────────────────────────
  const rows: ReconciliationContractRow[] = contracts.map((c) => {
    const cutoffYmd = c.status === "terminated" ? (c.terminated_at ?? c.end_date).slice(0, 10) : c.end_date;
    const cutoffMonth = monthKey(cutoffYmd);
    const startMonthKey = monthKey(c.start_date);

    const child = c.status === "renewed" ? childByParentId.get(c.id) ?? null : null;

    const cells = months.map((w) => {
      const wKey = monthKey(w.first);

      if (wKey < startMonthKey) return emptyCell("not_started");

      if (wKey > cutoffMonth) {
        if (c.status === "renewed") {
          const cell = emptyCell("renewed_out");
          cell.refContractId = child?.id ?? null;
          cell.refContractNumber = child?.contract_number ?? null;
          return cell;
        }
        if (c.status === "terminated") return emptyCell("terminated");
        // Still active, no successor yet — beyond-tenure escalation estimate.
        const lastSubtotal = Number(c.subtotal || c.total_amount);
        const escalationPct = c.escalation_percentage ?? 10;
        const projectedSubtotal = Math.round(lastSubtotal * (1 + escalationPct / 100));
        const { totalAmount } = computeGstAndRounding(projectedSubtotal, c.tax_percentage ?? 18);
        const cell = emptyCell("projected");
        cell.amount = totalAmount;
        return cell;
      }

      const reason = moratoriumByContractMonth.get(c.id)?.get(wKey);
      if (reason) {
        const cell = emptyCell("moratorium");
        cell.reason = reason;
        return cell;
      }

      const statement = statementsByContractMonth.get(c.id)?.get(wKey);
      if (statement) {
        const payments = paymentsByStatement.get(statement.id) ?? [];
        const settlement = computeSettlement(statement.total_amount, payments);
        const cell = emptyCell(
          settlement.paymentStatus === "paid" ? "paid" : settlement.paymentStatus === "partially_paid" ? "partial" : "unpaid"
        );
        cell.amount = settlement.settlementAmount;
        cell.collected = settlement.totalPaid;
        cell.owed = settlement.balanceDue;
        cell.invoiceNumber = statement.gst_invoice_number || statement.statement_number;
        cell.statementId = statement.id;
        return cell;
      }

      // Not yet billed — project what the real generator would eventually charge.
      const split = computeRenewalSplitRentSegments(
        c.id, c.start_date, c.end_date, c.subtotal, c.total_amount, c.phase_start_date,
        c.tax_percentage, undefined, ratePhasesByContract, w.first, w.last,
        new Date(w.year, w.month, 0).getDate()
      );
      if (split.amount <= 0) return emptyCell("not_started");
      const { totalAmount } = computeGstAndRounding(split.amount, split.taxPercentage);
      const cell = emptyCell("future");
      cell.amount = totalAmount;
      return cell;
    });

    const rowTotalAmount = cells.reduce((s, cell) => s + cell.amount, 0);
    const rowTotalOwed = cells.reduce((s, cell) => s + cell.owed, 0);

    return {
      id: c.id,
      contractNumber: c.contract_number,
      status: c.status,
      companyName: leadName(c.lead ?? {}),
      locationId: c.location_id ?? "",
      locationName: c.location?.name ?? "(no location)",
      startDate: c.start_date,
      endDate: c.end_date,
      terminatedAt: c.terminated_at,
      escalationPercentage: c.escalation_percentage,
      isRenewal: !!c.is_renewal,
      renewedAt: c.renewed_at,
      parentContractId: c.parent_contract_id,
      parentContractNumber: c.parent_contract_id ? parentById.get(c.parent_contract_id)?.contract_number ?? null : null,
      cells,
      rowTotalAmount,
      rowTotalOwed,
    };
  });

  // ── 5. Group by location, alphabetically, with subtotals ─────────────────
  const byLocation = new Map<string, ReconciliationContractRow[]>();
  for (const row of rows) {
    const key = row.locationName;
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key)!.push(row);
  }

  const groups: ReconciliationGroup[] = [...byLocation.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locationName, groupRows]) => {
      const monthlyTotals = months.map((_, i) =>
        groupRows.reduce(
          (acc, r) => ({ amount: acc.amount + r.cells[i].amount, owed: acc.owed + r.cells[i].owed }),
          { amount: 0, owed: 0 }
        )
      );
      return {
        locationId: groupRows[0]?.locationId ?? "",
        locationName,
        contracts: groupRows,
        monthlyTotals,
        totalAmount: groupRows.reduce((s, r) => s + r.rowTotalAmount, 0),
        totalOwed: groupRows.reduce((s, r) => s + r.rowTotalOwed, 0),
      };
    });

  const overallMonthlyTotals = months.map((_, i) =>
    groups.reduce(
      (acc, g) => ({ amount: acc.amount + g.monthlyTotals[i].amount, owed: acc.owed + g.monthlyTotals[i].owed }),
      { amount: 0, owed: 0 }
    )
  );

  return {
    months,
    groups,
    overall: {
      monthlyTotals: overallMonthlyTotals,
      totalAmount: groups.reduce((s, g) => s + g.totalAmount, 0),
      totalOwed: groups.reduce((s, g) => s + g.totalOwed, 0),
    },
  };
}

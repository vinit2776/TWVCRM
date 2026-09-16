/**
 * Contract/month grouped usage billing — the engine behind the Unbilled usage
 * screen, where every unbilled usage charge is listed grouped by contract then
 * month, and each contract-month is invoiced only when someone clicks
 * Review & send.
 *
 * Rules (agreed with Vinit, see the build plan artifact):
 *   - One invoice per contract per month; an invoice never spans two months.
 *   - The current (still-open) month is listed but can't be sent.
 *   - A late charge for an already-invoiced month gets its own invoice.
 *   - Ended contracts still bill.
 *   - Held charges never bill; charges older than
 *     USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS need Bill anyway first.
 *   - Route (proforma_first / gst_direct) comes from the contract.
 *
 * Sources: usage_charges (manual, including every booking charge — bookings
 * post their charge here at booking time or at checkout for quota rooms),
 * service_usage_records (print overage) and facility_usage_records. Bookings
 * are never billed directly: doing so alongside their pooled usage charge
 * would bill the same meeting twice.
 *
 * Lifecycle of one send:
 *   prepareUsageInvoice  → create_usage_invoice RPC: locks + links the charges
 *                          to a new draft statement in one transaction.
 *   (preview via the existing preview-send / proforma-pdf?preview=1 routes)
 *   sendPreparedUsageInvoice → finalize + dispatch by the contract's route.
 *                          If nothing irreversible happened (no payment link,
 *                          no GST number, nothing sent), a failure discards the
 *                          draft and returns the charges to the list.
 *   cancelPreparedUsageInvoice → discard the draft, release the charges.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeGstAndRounding } from "@/lib/gst-math";
import { USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS } from "@/lib/constants";
import { buildServiceDescription, ensureAccountingPeriod, monthLabel } from "@/lib/billing";
import { dispatchGstDirect, dispatchProforma } from "@/lib/send-proforma";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";

// ─── Types ───────────────────────────────────────────────────────────────────

export type UsageSource = "manual" | "print" | "facility";

export interface UnbilledUsageCharge {
  /** `${source}:${id}` — stable across sources. */
  key: string;
  id: string;
  source: UsageSource;
  contractId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  /** Ex-GST amount. */
  amount: number;
  /** YYYY-MM-DD. Print/facility use their period's last day. */
  date: string;
  year: number;
  month: number;
  held: boolean;
  holdReason: string | null;
  reviewed: boolean;
  bookingNumber: string | null;
}

export type MonthBlock = "open_month" | "accounting_locked" | null;

export interface UsageMonthGroup {
  /** "2026-08" */
  key: string;
  year: number;
  month: number;
  label: string;
  /** Every listed charge for the month, including held / needs-review / within-quota. */
  charges: Array<UnbilledUsageCharge & { status: ChargeStatus }>;
  /** Keys of the charges that will go on the invoice. */
  billableKeys: string[];
  /** Ex-GST total of billable charges. */
  subtotal: number;
  taxAmount: number;
  total: number;
  block: MonthBlock;
  /** Statement number of an earlier invoice already sent for this contract-month. */
  alreadyInvoiced: string | null;
  canSend: boolean;
}

export type ChargeStatus = "billable" | "held" | "needs_review" | "within_quota";

export interface UsageContractGroup {
  contractId: string;
  contractNumber: string;
  customerName: string;
  billingMode: "proforma_first" | "gst_direct";
  taxPercentage: number;
  ended: boolean;
  months: UsageMonthGroup[];
  subtotal: number;
  total: number;
}

export interface ContractFacts {
  id: string;
  contract_number: string;
  status: string;
  end_date: string | null;
  billing_mode: string | null;
  tax_percentage: number | null;
  lead: { first_name?: string | null; last_name?: string | null; company?: string | null } | null;
}

export interface GroupingInput {
  charges: UnbilledUsageCharge[];
  contracts: Map<string, ContractFacts>;
  /** "contractId:YYYY-MM" → statement number of a sent/paid usage or combined statement. */
  invoicedMonths: Map<string, string>;
  /** "YYYY-MM" of accounting periods with status locked. */
  lockedPeriods: Set<string>;
  /** Today in IST, YYYY-MM-DD. */
  today: string;
  reviewAfterDays?: number;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

const ENDED_STATUSES = new Set(["terminated", "expired", "cancelled", "renewed"]);

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey(year, month)}-${String(d).padStart(2, "0")}`;
}

export function istToday(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function customerNameOf(lead: ContractFacts["lead"]): string {
  if (!lead) return "—";
  return lead.company || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "—";
}

export function chargeStatus(c: UnbilledUsageCharge, today: string, reviewAfterDays: number): ChargeStatus {
  if (c.amount <= 0) return "within_quota";
  if (c.held) return "held";
  const cutoff = new Date(today + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - reviewAfterDays);
  if (!c.reviewed && c.date < cutoff.toISOString().slice(0, 10)) return "needs_review";
  return "billable";
}

/** Groups unbilled charges contract → month and works out what each month can send. */
export function groupUnbilledUsage(input: GroupingInput): UsageContractGroup[] {
  const reviewAfterDays = input.reviewAfterDays ?? USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS;
  const currentMonth = input.today.slice(0, 7);
  const byContract = new Map<string, Map<string, UnbilledUsageCharge[]>>();

  for (const c of input.charges) {
    if (!input.contracts.has(c.contractId)) continue;
    const months = byContract.get(c.contractId) ?? new Map<string, UnbilledUsageCharge[]>();
    const k = monthKey(c.year, c.month);
    months.set(k, [...(months.get(k) ?? []), c]);
    byContract.set(c.contractId, months);
  }

  const groups: UsageContractGroup[] = [];
  for (const [contractId, months] of byContract) {
    const contract = input.contracts.get(contractId)!;
    const taxPercentage = Number(contract.tax_percentage ?? 18);
    const monthGroups: UsageMonthGroup[] = [];

    for (const [k, list] of months) {
      const [year, month] = k.split("-").map(Number);
      const charges = list
        .map((c) => ({ ...c, status: chargeStatus(c, input.today, reviewAfterDays) }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
      const billable = charges.filter((c) => c.status === "billable");
      const subtotal = round2(billable.reduce((s, c) => s + c.amount, 0));
      const { taxAmount, totalAmount } = subtotal > 0
        ? computeGstAndRounding(subtotal, taxPercentage)
        : { taxAmount: 0, totalAmount: 0 };
      const block: MonthBlock = k >= currentMonth ? "open_month" : input.lockedPeriods.has(k) ? "accounting_locked" : null;
      monthGroups.push({
        key: k,
        year,
        month,
        label: monthLabel(month, year),
        charges,
        billableKeys: billable.map((c) => c.key),
        subtotal,
        taxAmount,
        total: totalAmount,
        block,
        alreadyInvoiced: input.invoicedMonths.get(`${contractId}:${k}`) ?? null,
        canSend: block === null && subtotal > 0,
      });
    }

    // Newest month first; charges that need nothing still show so they can be reviewed.
    monthGroups.sort((a, b) => b.key.localeCompare(a.key));
    const subtotal = round2(monthGroups.reduce((s, m) => s + m.subtotal, 0));
    const total = round2(monthGroups.reduce((s, m) => s + m.total, 0));
    groups.push({
      contractId,
      contractNumber: contract.contract_number,
      customerName: customerNameOf(contract.lead),
      billingMode: contract.billing_mode === "gst_direct" ? "gst_direct" : "proforma_first",
      taxPercentage,
      ended: ENDED_STATUSES.has(contract.status) || (!!contract.end_date && contract.end_date < input.today && contract.status !== "renewal_in_progress"),
      months: monthGroups,
      subtotal,
      total,
    });
  }

  return groups.sort((a, b) => a.contractNumber.localeCompare(b.contractNumber));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Data access ─────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST embed shapes (object vs array) vary by inference */
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Every unbilled charge across the three sources, optionally for one contract. */
export async function fetchUnbilledCharges(supabase: SupabaseClient, contractId?: string): Promise<UnbilledUsageCharge[]> {
  let manualQ = supabase
    .from("usage_charges")
    .select("id, contract_id, description, quantity, unit_price, total, charge_date, held_at, hold_reason, reviewed_at, booking:bookings!usage_charges_booking_id_fkey(booking_number)")
    .eq("status", "pending")
    .is("billing_statement_id", null)
    .not("contract_id", "is", null);
  let printQ = supabase
    .from("service_usage_records")
    .select("id, contract_id, overage_quantity, overage_rate_snapshot, amount, period_year, period_month, held_at, hold_reason, reviewed_at, service:service_catalog(name, printer_column)")
    .eq("is_billed", false)
    .is("billing_statement_id", null)
    .is("waived_at", null)
    .not("contract_id", "is", null);
  let facilityQ = supabase
    .from("facility_usage_records")
    .select("id, contract_id, billable_quantity, unit_price, total_charge, held_at, hold_reason, reviewed_at, accounting_period:accounting_periods(year, month), contract_facility:contract_facilities(name, unit)")
    .is("billing_statement_id", null)
    .is("waived_at", null)
    .not("contract_id", "is", null);
  if (contractId) {
    manualQ = manualQ.eq("contract_id", contractId);
    printQ = printQ.eq("contract_id", contractId);
    facilityQ = facilityQ.eq("contract_id", contractId);
  }

  const [manualRes, printRes, facilityRes] = await Promise.all([manualQ, printQ, facilityQ]);
  for (const r of [manualRes, printRes, facilityRes]) {
    if (r.error) throw new Error(`Failed to load usage charges: ${r.error.message}`);
  }

  const out: UnbilledUsageCharge[] = [];
  for (const r of (manualRes.data ?? []) as any[]) {
    const [year, month] = String(r.charge_date).split("-").map(Number);
    out.push({
      key: `manual:${r.id}`, id: r.id, source: "manual", contractId: r.contract_id,
      description: r.description, quantity: Number(r.quantity), unitPrice: Number(r.unit_price),
      amount: Number(r.total || 0), date: r.charge_date, year, month,
      held: !!r.held_at, holdReason: r.hold_reason ?? null, reviewed: !!r.reviewed_at,
      bookingNumber: one<any>(r.booking)?.booking_number ?? null,
    });
  }
  for (const r of (printRes.data ?? []) as any[]) {
    out.push({
      key: `print:${r.id}`, id: r.id, source: "print", contractId: r.contract_id,
      description: `${buildServiceDescription(r.service)} — ${Number(r.overage_quantity)} over quota`,
      quantity: Number(r.overage_quantity), unitPrice: Number(r.overage_rate_snapshot),
      amount: Number(r.overage_quantity) > 0 ? Number(r.amount || 0) : 0,
      date: lastDayOfMonth(r.period_year, r.period_month), year: r.period_year, month: r.period_month,
      held: !!r.held_at, holdReason: r.hold_reason ?? null, reviewed: !!r.reviewed_at, bookingNumber: null,
    });
  }
  for (const r of (facilityRes.data ?? []) as any[]) {
    const period = one<any>(r.accounting_period);
    if (!period) continue;
    const facility = one<any>(r.contract_facility);
    out.push({
      key: `facility:${r.id}`, id: r.id, source: "facility", contractId: r.contract_id,
      description: `${facility?.name ?? "Facility"} — ${Number(r.billable_quantity)} ${facility?.unit ?? "units"} over quota`,
      quantity: Number(r.billable_quantity), unitPrice: Number(r.unit_price),
      amount: Number(r.billable_quantity) > 0 ? Number(r.total_charge || 0) : 0,
      date: lastDayOfMonth(period.year, period.month), year: period.year, month: period.month,
      held: !!r.held_at, holdReason: r.hold_reason ?? null, reviewed: !!r.reviewed_at, bookingNumber: null,
    });
  }
  return out;
}

async function fetchGroupingFacts(supabase: SupabaseClient, contractIds: string[]) {
  const contracts = new Map<string, ContractFacts>();
  const invoicedMonths = new Map<string, string>();
  const lockedPeriods = new Set<string>();
  if (contractIds.length === 0) return { contracts, invoicedMonths, lockedPeriods };

  const [contractsRes, stmtsRes, periodsRes] = await Promise.all([
    supabase
      .from("contracts")
      .select("id, contract_number, status, end_date, billing_mode, tax_percentage, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
      .in("id", contractIds),
    supabase
      .from("billing_statements")
      .select("contract_id, statement_number, period_start, proforma_sent_at, gst_invoice_number, billing_payments:billing_payments(id)")
      .in("contract_id", contractIds)
      .in("statement_type", ["usage", "combined"])
      .is("voided_at", null)
      .neq("status", "discarded"),
    supabase.from("accounting_periods").select("year, month").eq("status", "locked"),
  ]);
  if (contractsRes.error) throw new Error(`Failed to load contracts: ${contractsRes.error.message}`);
  if (stmtsRes.error) throw new Error(`Failed to load statements: ${stmtsRes.error.message}`);

  for (const c of (contractsRes.data ?? []) as any[]) {
    contracts.set(c.id, { ...c, lead: one(c.lead) });
  }
  for (const s of (stmtsRes.data ?? []) as any[]) {
    const sent = !!s.proforma_sent_at || !!s.gst_invoice_number || (s.billing_payments?.length ?? 0) > 0;
    const k = `${s.contract_id}:${String(s.period_start).slice(0, 7)}`;
    if (sent && !invoicedMonths.has(k)) invoicedMonths.set(k, s.statement_number);
  }
  for (const p of (periodsRes.data ?? []) as any[]) lockedPeriods.add(monthKey(p.year, p.month));
  return { contracts, invoicedMonths, lockedPeriods };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getUnbilledUsage(supabase: SupabaseClient, contractId?: string): Promise<UsageContractGroup[]> {
  const charges = await fetchUnbilledCharges(supabase, contractId);
  const facts = await fetchGroupingFacts(supabase, [...new Set(charges.map((c) => c.contractId))]);
  return groupUnbilledUsage({ charges, ...facts, today: istToday() });
}

/** Old month-draft usage statements (never sent) — their charges don't appear in the list until discarded. */
export async function countOldUsageDrafts(supabase: SupabaseClient): Promise<number> {
  const { count } = await supabase
    .from("billing_statements")
    .select("id", { count: "exact", head: true })
    .eq("statement_type", "usage")
    .eq("status", "draft")
    .is("voided_at", null);
  return count ?? 0;
}

// ─── Prepare / send / cancel ─────────────────────────────────────────────────

export type UsageInvoiceError = { code: "stale" | "blocked" | "not_found" | "invalid" | "failed"; message: string };

export interface PrepareInput {
  contractId: string;
  year: number;
  month: number;
  /** Charge keys exactly as the screen showed them as billable. */
  chargeKeys: string[];
  /** Ex-GST subtotal the screen showed. */
  expectedSubtotal: number;
}

/** Line-item sections in the same shape generateUsageStatements writes, so PDF/email/statement view render unchanged. */
export function buildUsageLineItems(charges: UnbilledUsageCharge[], year: number, month: number) {
  const label = monthLabel(month, year);
  const manual = charges.filter((c) => c.source === "manual");
  const facility = charges.filter((c) => c.source === "facility");
  const print = charges.filter((c) => c.source === "print");
  const sum = (xs: UnbilledUsageCharge[]) => round2(xs.reduce((s, c) => s + c.amount, 0));
  return {
    sections: [
      {
        type: "ad_hoc_charges" as const,
        label: `Ad-hoc Charges — ${label}`,
        items: manual.map((c) => ({ usage_charge_id: c.id, description: c.description, quantity: c.quantity, unit_price: c.unitPrice, amount: c.amount })),
        subtotal: sum(manual),
      },
      {
        type: "facility_usage" as const,
        label: `Facility Usage — ${label}`,
        items: facility.map((c) => ({ facility_usage_record_id: c.id, description: c.description, qty: c.quantity, unit_price: c.unitPrice, billable: c.quantity, rate: c.unitPrice, amount: c.amount })),
        subtotal: sum(facility),
      },
      {
        type: "service_usage" as const,
        label: `Service Usage — ${label}`,
        items: print.map((c) => ({ service_usage_record_id: c.id, description: c.description, qty: c.quantity, unit_price: c.unitPrice, overage: c.quantity, rate: c.unitPrice, amount: c.amount })),
        subtotal: sum(print),
      },
    ].filter((s) => s.items.length > 0),
    manualSubtotal: sum(manual),
    facilitySubtotal: sum(facility),
    printSubtotal: sum(print),
  };
}

export async function prepareUsageInvoice(
  supabase: SupabaseClient,
  input: PrepareInput,
): Promise<{ statementId: string } | { error: UsageInvoiceError }> {
  const groups = await getUnbilledUsage(supabase, input.contractId);
  const group = groups.find((g) => g.contractId === input.contractId);
  const monthGroup = group?.months.find((m) => m.year === input.year && m.month === input.month);
  if (!group || !monthGroup) return { error: { code: "stale", message: "Nothing left to bill for this month — refresh the list." } };
  if (monthGroup.block === "open_month") return { error: { code: "blocked", message: `${monthGroup.label} is still open. It can be sent after the month ends.` } };
  if (monthGroup.block === "accounting_locked") return { error: { code: "blocked", message: `${monthGroup.label} is locked in accounting. Unlock the period or re-date the charges first.` } };

  // The screen's view must match the server's current view exactly.
  const requested = [...new Set(input.chargeKeys)].sort();
  const current = [...monthGroup.billableKeys].sort();
  if (requested.length === 0) return { error: { code: "invalid", message: "No charges selected." } };
  if (requested.join("|") !== current.join("|") || Math.abs(monthGroup.subtotal - input.expectedSubtotal) > 0.005) {
    return { error: { code: "stale", message: "Charges for this month changed since the list loaded — refresh and review again." } };
  }

  const charges = monthGroup.charges.filter((c) => c.status === "billable");
  const { sections, manualSubtotal, facilitySubtotal, printSubtotal } = buildUsageLineItems(charges, input.year, input.month);
  const subtotal = monthGroup.subtotal;
  const { cgst, sgst, igst, taxAmount, totalAmount } = computeGstAndRounding(subtotal, group.taxPercentage);

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, lead_id, po_number, lead:leads!contracts_lead_id_fkey(gst_number)")
    .eq("id", input.contractId)
    .single();
  if (!contract) return { error: { code: "not_found", message: "Contract not found." } };

  const periodId = await ensureAccountingPeriod(supabase, input.month, input.year);
  const statement = {
    contract_id: input.contractId,
    lead_id: contract.lead_id,
    period_start: `${monthKey(input.year, input.month)}-01`,
    period_end: lastDayOfMonth(input.year, input.month),
    // Set at send time (today + 7) — a period-end due date would already be past for a late month.
    due_date: null,
    statement_type: "usage",
    fixed_amount: 0,
    usage_amount: round2(manualSubtotal + facilitySubtotal),
    service_usage_amount: printSubtotal,
    booking_usage_amount: 0,
    subtotal,
    tax_percentage: group.taxPercentage,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    status: "draft",
    accounting_period_id: periodId ?? null,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    is_interstate: false,
    buyer_gstin: one<{ gst_number: string | null }>(contract.lead as unknown as { gst_number: string | null } | null)?.gst_number ?? null,
    place_of_supply: "Tamil Nadu",
    po_number: contract.po_number ?? null,
    line_items: sections,
    prepaid_month: null,
    prepaid_year: null,
    // Deliberately not linked as a "supplement": idx_bs_one_live_supplement_per_original
    // enforces the old one-top-up-per-month rule, and this flow allows any
    // number of invoices for a month (a late charge simply gets its own).
    supplements_statement_id: null,
  };

  const ids = (source: UsageSource) => charges.filter((c) => c.source === source).map((c) => c.id);
  const { data, error } = await supabase.rpc("create_usage_invoice", {
    p_statement: statement,
    p_contract_id: input.contractId,
    p_usage_charge_ids: ids("manual"),
    p_service_record_ids: ids("print"),
    p_facility_record_ids: ids("facility"),
    p_expected_subtotal: subtotal,
  });
  if (error) {
    if (error.message.includes("USAGE_INVOICE_STALE")) {
      return { error: { code: "stale", message: "Someone else just billed or changed one of these charges — refresh the list." } };
    }
    return { error: { code: "failed", message: error.message } };
  }
  return { statementId: data as string };
}

/** Releases every charge linked to a statement back to unbilled. */
export async function releaseStatementCharges(supabase: SupabaseClient, statementId: string): Promise<void> {
  await Promise.all([
    supabase.from("usage_charges").update({ billing_statement_id: null, status: "pending" }).eq("billing_statement_id", statementId),
    supabase.from("service_usage_records").update({ billing_statement_id: null, is_billed: false }).eq("billing_statement_id", statementId),
    supabase.from("facility_usage_records").update({ billing_statement_id: null }).eq("billing_statement_id", statementId),
    supabase.from("bookings").update({ billing_statement_id: null }).eq("billing_statement_id", statementId),
  ]);
}

async function discardDraft(supabase: SupabaseClient, statementId: string, userId: string, reason: string): Promise<void> {
  await supabase
    .from("billing_statements")
    .update({ status: "discarded", discarded_at: new Date().toISOString(), discarded_by: userId, discard_reason: reason })
    .eq("id", statementId)
    .eq("status", "draft");
  await releaseStatementCharges(supabase, statementId);
}

async function loadPreparedDraft(supabase: SupabaseClient, statementId: string) {
  const { data } = await supabase
    .from("billing_statements")
    .select("id, status, statement_type, voided_at, total_amount, contract_id, statement_number, contract:contracts!billing_statements_contract_id_fkey(billing_mode)")
    .eq("id", statementId)
    .single();
  return data;
}

export async function cancelPreparedUsageInvoice(
  supabase: SupabaseClient,
  statementId: string,
  userId: string,
): Promise<{ ok: true } | { error: UsageInvoiceError }> {
  const draft = await loadPreparedDraft(supabase, statementId);
  if (!draft || draft.statement_type !== "usage") return { error: { code: "not_found", message: "Draft not found." } };
  if (draft.status !== "draft") return { error: { code: "invalid", message: `This invoice is already ${draft.status}.` } };
  await discardDraft(supabase, statementId, userId, "Cancelled from Review & send before sending");
  return { ok: true };
}

export type SendOutcome =
  | { kind: "sent"; statementNumber: string; emailedTo: string | null }
  | { kind: "handed_off"; statementNumber: string }
  | { kind: "not_sent_released"; reason: string }
  | { kind: "not_delivered_kept"; statementNumber: string; reason: string };

export async function sendPreparedUsageInvoice(
  supabase: SupabaseClient,
  statementId: string,
  userId: string,
): Promise<SendOutcome | { error: UsageInvoiceError }> {
  const draft = await loadPreparedDraft(supabase, statementId);
  if (!draft || draft.statement_type !== "usage") return { error: { code: "not_found", message: "Draft not found." } };
  if (draft.voided_at || draft.status !== "draft") return { error: { code: "invalid", message: `This invoice is already ${draft.status}.` } };
  if (Number(draft.total_amount) <= 0) return { error: { code: "invalid", message: "Nothing to bill on this invoice." } };

  const billingMode = (one<{ billing_mode: string | null }>(draft.contract as unknown as { billing_mode: string | null } | null)?.billing_mode === "gst_direct")
    ? "gst_direct" as const
    : "proforma_first" as const;

  const { error: finErr } = await supabase
    .from("billing_statements")
    .update({ status: "finalized", finalized_at: new Date().toISOString() })
    .eq("id", statementId)
    .eq("status", "draft");
  if (finErr) return { error: { code: "failed", message: finErr.message } };

  const releaseIfUntouched = async (reason: string): Promise<SendOutcome> => {
    const { data: after } = await supabase
      .from("billing_statements")
      .select("proforma_sent_at, gst_invoice_number, razorpay_payment_link_id, issuance_channel")
      .eq("id", statementId)
      .single();
    const irreversible = !!after?.proforma_sent_at || !!after?.gst_invoice_number || !!after?.razorpay_payment_link_id || after?.issuance_channel === "tally";
    if (irreversible) return { kind: "not_delivered_kept", statementNumber: draft.statement_number, reason };
    // Back to draft first so the discard guard (status = draft) applies.
    await supabase.from("billing_statements").update({ status: "draft", finalized_at: null }).eq("id", statementId);
    await discardDraft(supabase, statementId, userId, `Send failed: ${reason}`);
    return { kind: "not_sent_released", reason };
  };

  try {
    const handoff = await handleStatementFinalized(supabase, statementId, billingMode, "usage_billing_send");
    if (handoff.skipLegacyDispatch) return { kind: "handed_off", statementNumber: draft.statement_number };

    const result = billingMode === "gst_direct"
      ? await dispatchGstDirect(supabase, statementId, userId)
      : await dispatchProforma(supabase, statementId, userId);

    if (!result.success) return await releaseIfUntouched(result.error || "Dispatch failed");
    // Handed to Tally, or GST issuance paused (standby) — queued, not failed.
    if (result.routedToTally || result.standby) return { kind: "handed_off", statementNumber: draft.statement_number };
    if (result.noContact) return await releaseIfUntouched("No email or phone on file for this customer");
    return { kind: "sent", statementNumber: draft.statement_number, emailedTo: result.emailedTo ?? null };
  } catch (e) {
    return await releaseIfUntouched(e instanceof Error ? e.message : "Dispatch failed");
  }
}

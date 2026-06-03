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
  /** Contract numbers skipped by the quarterly billing gate (expected, not errors). */
  quarterlySkipped: string[];
  /** Statement numbers of legacy combined drafts that were voided so a fresh
   *  rent + usage split could replace them. Cutover housekeeping — surfaced in
   *  the operator confirmation so they know what's being replaced. */
  superseded: string[];
  /** Contracts skipped because a covering statement was already SENT to the
   *  client (proforma_sent_at set) or paid or GST-issued — never replaced. */
  alreadySent: string[];
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

// ── Helpers ───────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

/** Get month name + year label, e.g. "June 2026" */
function monthLabel(month: number, year: number): string {
  return new Date(year, month - 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
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

/**
 * @deprecated Use generateRentProformas() + generateUsageStatements() instead.
 * This combined generator is kept for the contract-activation hook
 * (src/app/api/contracts/[id]/route.ts) which generates the first statement
 * immediately on activation. It will be removed once that hook is updated.
 *
 * Generate draft billing statements for active contracts whose tenure overlaps
 * the target month. Idempotent: existing statements for the period are left
 * alone (they're never duplicated).
 *
 * The target month is the USAGE month (current month). The invoice will also
 * include prepaid rent for the next month.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateMonthlyStatements(
  supabase: SupabaseClient,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const now = istNow();
  const targetMonth = opts.month ?? now.getMonth() + 1;   // usage month
  const targetYear = opts.year ?? now.getFullYear();

  const firstOfMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
  const lastOfMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${daysInMonth}`;

  // Prepaid rent covers the NEXT month
  const prepaid = nextMonth(targetMonth, targetYear);
  const prepaidDaysInMonth = new Date(prepaid.year, prepaid.month, 0).getDate();

  // 1. Ensure accounting period exists
  const { data: existingPeriod } = await supabase
    .from("accounting_periods")
    .select("id")
    .eq("year", targetYear)
    .eq("month", targetMonth)
    .maybeSingle();

  let periodId = existingPeriod?.id as string | undefined;
  if (!periodId) {
    const { data: newPeriod } = await supabase
      .from("accounting_periods")
      .insert({ year: targetYear, month: targetMonth, status: "open" })
      .select("id")
      .single();
    periodId = newPeriod?.id;
  }

  // 2. Fetch active contracts whose tenure overlaps this month
  let contractsQuery = supabase
    .from("contracts")
    .select(`
      id, contract_number, title, total_amount, subtotal, tax_percentage, tax_amount,
      billing_cycle, start_date, end_date, next_billing_date, seats,
      location_id, lead_id,
      lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number)
    `)
    .in("status", ["active", "renewal_in_progress"])
    .lte("start_date", lastOfMonth)
    .gte("end_date", firstOfMonth);

  if (opts.contractId) contractsQuery = contractsQuery.eq("id", opts.contractId);

  const { data: contracts } = await contractsQuery;

  const result: GenerateResult = {
    month: targetMonth, year: targetYear,
    generated: 0, skipped: 0, errors: [], statementIds: [],
    noContact: [], quarterlySkipped: [], superseded: [], alreadySent: [], preview: [],
  };

  if (!contracts || contracts.length === 0) return result;

  // 3. Find existing statements for this period to skip duplicates
  const contractIds = contracts.map((c) => c.id as string);
  const { data: existingStatements } = await supabase
    .from("billing_statements")
    .select("contract_id")
    .in("contract_id", contractIds)
    .gte("period_start", firstOfMonth)
    .lte("period_start", lastOfMonth);

  const alreadyBilled = new Set(
    (existingStatements || []).map((s: { contract_id: string }) => s.contract_id)
  );

  const billable = (contracts as Array<{ id: string }>)
    .filter((c) => !alreadyBilled.has(c.id))
    .map((c) => c.id);

  // 3a. Pre-fetch ALL usage data in batch (2-4 round trips regardless of contract count)
  const [usageRes, facilityRes, serviceRes, bookingsRes] = billable.length === 0
    ? [{ data: [] }, { data: [] }, { data: [] }, { data: [] }]
    : await Promise.all([
        // Ad-hoc usage charges (manual entries)
        supabase
          .from("usage_charges")
          .select("id, contract_id, description, quantity, unit_price, total")
          .in("contract_id", billable)
          .eq("status", "pending")
          .gte("charge_date", firstOfMonth)
          .lte("charge_date", lastOfMonth),

        // Facility usage records (meeting room quota overages)
        periodId
          ? supabase
              .from("facility_usage_records")
              .select("contract_id, contract_facility_id, quantity_used, free_quota_applied, billable_quantity, unit_price, total_charge")
              .in("contract_id", billable)
              .eq("accounting_period_id", periodId)
          : Promise.resolve({ data: [] }),

        // Service usage records (printer/service overages) — previously missing!
        supabase
          .from("service_usage_records")
          .select("id, contract_id, service_id, quantity_used, quota_snapshot, overage_quantity, overage_rate_snapshot, amount, is_billed")
          .in("contract_id", billable)
          .eq("period_year", targetYear)
          .eq("period_month", targetMonth)
          .eq("is_billed", false),

        // Contract-holder bookings completed this month (auto-rollup)
        supabase
          .from("bookings")
          .select("id, booking_number, contract_id, space_id, booking_date, start_time, end_time, duration_hours, pricing_model, hourly_rate, total_amount, quantity, payment_status, status, space:spaces!bookings_space_id_fkey(name)")
          .in("contract_id", billable)
          .eq("customer_type", "contract_holder")
          .in("status", ["confirmed", "checked_in", "checked_out"])
          .gte("booking_date", firstOfMonth)
          .lte("booking_date", lastOfMonth),
      ]);

  type UsageRow = { id: string; contract_id: string; description: string; quantity: number; unit_price: number; total: number };
  type FacilityRow = { contract_id: string; contract_facility_id: string; quantity_used: number; free_quota_applied: number; billable_quantity: number; unit_price: number; total_charge: number };
  type ServiceRow = { id: string; contract_id: string; service_id: string; quantity_used: number; quota_snapshot: number; overage_quantity: number; overage_rate_snapshot: number; amount: number; is_billed: boolean };
  type BookingRow = { id: string; booking_number: string; contract_id: string; space_id: string; booking_date: string; start_time: string; end_time: string; duration_hours: number; pricing_model: string; hourly_rate: number; total_amount: number; quantity: number; payment_status: string; status: string; space: { name: string }[] | { name: string } | null };

  // Index by contract_id for O(1) lookup inside the per-contract loop
  const usageByContract = new Map<string, UsageRow[]>();
  for (const u of (usageRes.data ?? []) as UsageRow[]) {
    const list = usageByContract.get(u.contract_id) ?? [];
    list.push(u);
    usageByContract.set(u.contract_id, list);
  }

  const facilityByContract = new Map<string, FacilityRow[]>();
  for (const f of (facilityRes.data ?? []) as FacilityRow[]) {
    const list = facilityByContract.get(f.contract_id) ?? [];
    list.push(f);
    facilityByContract.set(f.contract_id, list);
  }

  const serviceByContract = new Map<string, ServiceRow[]>();
  for (const s of (serviceRes.data ?? []) as ServiceRow[]) {
    const list = serviceByContract.get(s.contract_id) ?? [];
    list.push(s);
    serviceByContract.set(s.contract_id, list);
  }

  const bookingsByContract = new Map<string, BookingRow[]>();
  for (const b of (bookingsRes.data ?? []) as BookingRow[]) {
    const list = bookingsByContract.get(b.contract_id) ?? [];
    list.push(b);
    bookingsByContract.set(b.contract_id, list);
  }

  // 4. Generate drafts
  for (const contract of contracts as Array<Record<string, unknown>>) {
    if (alreadyBilled.has(contract.id as string)) {
      result.skipped++;
      continue;
    }

    try {
      const cid = contract.id as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = contract.lead as any;

      // ── Section A: Prepaid rent for NEXT month ──────────────────────

      // Check if contract extends into the prepaid month
      const contractEnd = new Date(String(contract.end_date) + "T00:00:00Z");
      const prepaidFirstOfMonth = new Date(
        `${prepaid.year}-${String(prepaid.month).padStart(2, "0")}-01T00:00:00Z`
      );
      const prepaidLastOfMonth = new Date(
        `${prepaid.year}-${String(prepaid.month).padStart(2, "0")}-${prepaidDaysInMonth}T00:00:00Z`
      );

      const baseAmount = Number(contract.subtotal || contract.total_amount);
      let prepaidRentAmount: number;

      if (contractEnd < prepaidFirstOfMonth) {
        // Contract ends before next month — no prepaid rent
        prepaidRentAmount = 0;
      } else {
        // Prorate if contract ends mid-month in the prepaid month
        const contractStart = new Date(String(contract.start_date) + "T00:00:00Z");
        const billableStart = contractStart > prepaidFirstOfMonth ? contractStart : prepaidFirstOfMonth;
        const billableEnd = contractEnd < prepaidLastOfMonth ? contractEnd : prepaidLastOfMonth;
        const billableDays = Math.floor((billableEnd.getTime() - billableStart.getTime()) / 86400000) + 1;

        if (billableDays >= prepaidDaysInMonth) {
          prepaidRentAmount = baseAmount;
        } else {
          prepaidRentAmount = Math.round((baseAmount / prepaidDaysInMonth) * billableDays);
        }
      }

      const prepaidSection: LineItemSection = {
        type: "prepaid_rent",
        label: `Prepaid Rent — ${monthLabel(prepaid.month, prepaid.year)}`,
        items: prepaidRentAmount > 0
          ? [{
              description: `Monthly rent${contract.seats ? ` (${contract.seats} seat${Number(contract.seats) > 1 ? "s" : ""})` : ""}`,
              amount: prepaidRentAmount,
            }]
          : [],
        subtotal: prepaidRentAmount,
      };

      // ── Section B: Current month usage ──────────────────────────────

      // B1. Contract bookings (auto-rolled)
      const bookings = bookingsByContract.get(cid) ?? [];
      const bookingItems = bookings
        .sort((a, b) => a.booking_date.localeCompare(b.booking_date) || a.start_time.localeCompare(b.start_time))
        .map((b) => {
          // Free quota bookings (posted_to_bill or waived) show as ₹0
          const isFree = b.payment_status === "posted_to_bill" || b.payment_status === "waived";
          const amount = isFree ? 0 : Number(b.total_amount || 0);
          const spaceObj = Array.isArray(b.space) ? b.space[0] : b.space;
          const spaceName = (spaceObj && typeof spaceObj === "object" && "name" in spaceObj)
            ? (spaceObj as { name: string }).name
            : "Space";
          return {
            booking_id: b.id,
            booking_number: b.booking_number,
            date: b.booking_date,
            space: spaceName,
            time: `${b.start_time?.slice(0, 5)}–${b.end_time?.slice(0, 5)}`,
            duration: b.pricing_model === "daily"
              ? `${Number(b.quantity || 1)} seat${Number(b.quantity || 1) > 1 ? "s" : ""}`
              : `${Number(b.duration_hours)}h`,
            amount,
            note: isFree ? "Free quota" : undefined,
          };
        });
      const bookingUsageAmount = bookingItems.reduce((s, i) => s + (i.amount as number), 0);

      const bookingSection: LineItemSection = {
        type: "booking_usage",
        label: `Meeting Room Usage — ${monthLabel(targetMonth, targetYear)}`,
        items: bookingItems,
        subtotal: bookingUsageAmount,
      };

      // B2. Ad-hoc usage charges (manual entries)
      const usageCharges = usageByContract.get(cid) ?? [];
      const adHocSection: LineItemSection = {
        type: "ad_hoc_charges",
        label: `Ad-hoc Charges — ${monthLabel(targetMonth, targetYear)}`,
        items: usageCharges.map((c) => ({
          usage_charge_id: c.id,
          description: c.description,
          quantity: Number(c.quantity),
          unit_price: Number(c.unit_price),
          amount: Number(c.total || 0),
        })),
        subtotal: usageCharges.reduce((s, c) => s + Number(c.total || 0), 0),
      };

      // B3. Facility usage records (meeting room quota overages)
      const facilityRecords = facilityByContract.get(cid) ?? [];
      const facilitySection: LineItemSection = {
        type: "facility_usage",
        label: `Facility Usage — ${monthLabel(targetMonth, targetYear)}`,
        items: facilityRecords.map((f) => ({
          facility_id: f.contract_facility_id,
          quantity_used: Number(f.quantity_used),
          free_quota: Number(f.free_quota_applied),
          billable: Number(f.billable_quantity),
          rate: Number(f.unit_price),
          amount: Number(f.total_charge || 0),
        })),
        subtotal: facilityRecords.reduce((s, f) => s + Number(f.total_charge || 0), 0),
      };

      // B4. Service usage records (printer/service overages) — NEW
      const serviceRecords = serviceByContract.get(cid) ?? [];
      const serviceSection: LineItemSection = {
        type: "service_usage",
        label: `Service Usage — ${monthLabel(targetMonth, targetYear)}`,
        items: serviceRecords.map((s) => ({
          service_usage_id: s.id,
          service_id: s.service_id,
          quantity_used: Number(s.quantity_used),
          quota: Number(s.quota_snapshot),
          overage: Number(s.overage_quantity),
          rate: Number(s.overage_rate_snapshot),
          amount: Number(s.amount || 0),
        })),
        subtotal: serviceRecords.reduce((s, r) => s + Number(r.amount || 0), 0),
      };

      // ── Totals ──────────────────────────────────────────────────────

      const fixedAmount = prepaidRentAmount;
      const usageAmount = adHocSection.subtotal + facilitySection.subtotal;
      const serviceUsageAmount = serviceSection.subtotal;
      const bookingUsageTotal = bookingSection.subtotal;

      const subtotal = fixedAmount + usageAmount + serviceUsageAmount + bookingUsageTotal;
      const taxPercentage = Number(contract.tax_percentage || 18);

      // GST split — intra-state (TN) vs inter-state
      const buyerState = (lead?.state || "").toLowerCase().trim();
      // Place of supply is always Tamil Nadu — service rendered at TWV premises (always CGST+SGST)
      const isInterstate = false;

      let cgst = 0, sgst = 0;
      const igst = 0;
      cgst = Math.round(subtotal * (taxPercentage / 200) );
        sgst = Math.round(subtotal * (taxPercentage / 200) );
      const taxAmount = cgst + sgst + igst;
      const totalAmount = subtotal + taxAmount;

      // Build the line_items array (only include sections with items)
      const lineItems: LineItemSection[] = [
        prepaidSection,
        bookingSection,
        adHocSection,
        facilitySection,
        serviceSection,
      ].filter((s) => s.items.length > 0);

      const { data: statement, error: insertErr } = await supabase
        .from("billing_statements")
        .insert({
          contract_id: cid,
          lead_id: contract.lead_id,
          period_start: firstOfMonth,
          period_end: lastOfMonth,
          due_date: dueDateFromPeriodEnd(lastOfMonth),
          fixed_amount: fixedAmount,
          usage_amount: usageAmount,
          service_usage_amount: serviceUsageAmount,
          booking_usage_amount: bookingUsageTotal,
          subtotal,
          tax_percentage: taxPercentage,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          status: "draft",
          accounting_period_id: periodId,
          cgst_amount: cgst,
          sgst_amount: sgst,
          igst_amount: igst,
          is_interstate: isInterstate,
          buyer_gstin: lead?.gst_number || null,
          place_of_supply: isInterstate ? (lead?.state || "Other") : "Tamil Nadu",
          line_items: lineItems,
          prepaid_month: prepaid.month,
          prepaid_year: prepaid.year,
        })
        .select("id")
        .single();

      if (insertErr) {
        result.errors.push(`${contract.contract_number}: ${insertErr.message}`);
        continue;
      }

      // Link usage charges to the new statement and mark billed
      if (usageCharges.length > 0 && statement) {
        const chargeIds = usageCharges.map((c) => c.id);
        await supabase
          .from("usage_charges")
          .update({ billing_statement_id: statement.id, status: "billed" })
          .in("id", chargeIds);
      }

      // Link service usage records to the new statement and mark billed
      if (serviceRecords.length > 0 && statement) {
        const serviceIds = serviceRecords.map((s) => s.id);
        await supabase
          .from("service_usage_records")
          .update({ billing_statement_id: statement.id, is_billed: true })
          .in("id", serviceIds);
      }

      // Link bookings to the new statement so the monthly-summary stops
      // showing them as "unbilled". Previously bookings were silently omitted
      // from this update — usage_charges and service_usage_records were marked
      // correctly but bookings were not, causing them to keep appearing as
      // "Unbilled Bookings" even after the statement was finalized.
      if (bookings.length > 0 && statement) {
        const bookingIds = bookings.map((b) => b.id);
        await supabase
          .from("bookings")
          .update({ billing_statement_id: statement.id })
          .in("id", bookingIds);
      }

      result.generated++;
      if (statement?.id) result.statementIds.push(statement.id as string);
    } catch (err) {
      result.errors.push(`${contract.contract_number}: ${String(err)}`);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW GENERATORS — split rent proformas and usage statements
// ═══════════════════════════════════════════════════════════════════════════

import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";
import { createAdminClient } from "@/lib/supabase/server";

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
    statementIds: [], noContact: [], quarterlySkipped: [], superseded: [], alreadySent: [], preview: [],
  };

  // Fetch active contracts: include any contract that starts before/during the prepaid month
  // (contracts starting in June must appear in the May billing run that generates June rent)
  let contractsQuery = supabase
    .from("contracts")
    .select(`
      id, contract_number, title, total_amount, subtotal, tax_percentage,
      billing_cycle, start_date, end_date, next_billing_date, seats,
      location_id, lead_id, billing_mode,
      lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, state, gst_number)
    `)
    .in("status", ["active", "renewal_in_progress"])
    .lte("start_date", prepaidLastOfMonth)
    .gte("end_date", firstOfTargetMonth);

  if (opts.contractId) contractsQuery = contractsQuery.eq("id", opts.contractId);
  const { data: contracts } = await contractsQuery;
  if (!contracts || contracts.length === 0) return result;

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
    .select("id, contract_id, statement_number, prepaid_month, prepaid_year, period_start, statement_type, proforma_sent_at, gst_invoice_number, billing_payments:billing_payments(id)")
    .in("contract_id", contractIds)
    .in("statement_type", ["rent", "combined"])
    .is("voided_at", null)
    .or(`and(prepaid_month.eq.${prepaid.month},prepaid_year.eq.${prepaid.year}),and(statement_type.eq.combined,period_start.eq.${firstOfTargetMonth},prepaid_month.is.null)`);

  const alreadySent = new Set<string>();
  const supersedable = new Map<string, { id: string; statement_number: string }>();
  for (const s of (coveringStmts || []) as Array<{
    id: string; contract_id: string; statement_number: string;
    proforma_sent_at: string | null; gst_invoice_number: string | null;
    billing_payments: { id: string }[];
  }>) {
    const wasSentOrPaid = !!s.proforma_sent_at || !!s.gst_invoice_number || (s.billing_payments?.length ?? 0) > 0;
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
  const { data: allAddonsRaw } = await adminSupabase
    .from("contract_addons")
    .select("id,description,amount,effective_from,effective_until,contract_id")
    .in("contract_id", contractIds)
    .eq("is_active", true)
    .lte("effective_from", prepaidLastOfMonth)
    .or(`effective_until.is.null,effective_until.gte.${prepaidFirstOfMonth}`);

  type AddonRow = { id: string; description: string; amount: number; effective_from: string; effective_until: string | null; contract_id: string };
  const addonsByContractId = new Map<string, AddonRow[]>();
  for (const addon of (allAddonsRaw ?? []) as AddonRow[]) {
    const list = addonsByContractId.get(addon.contract_id) ?? [];
    list.push(addon);
    addonsByContractId.set(addon.contract_id, list);
  }

  for (const contract of contracts as Array<Record<string, unknown>>) {
    const cid            = contract.id as string;
    const contractNumber = contract.contract_number as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead           = contract.lead as any;

    try {
      // ── 1. Quarterly gate ───────────────────────────────────────────────
      if (contract.billing_cycle === "quarterly") {
        const nbd = contract.next_billing_date as string | null;
        if (!nbd || nbd < prepaidFirstOfMonth || nbd > prepaidLastOfMonth) {
          result.quarterlySkipped.push(contractNumber);
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

      // ── 3. Proration ────────────────────────────────────────────────────
      const baseAmount    = Number(contract.subtotal || contract.total_amount);
      const contractEnd   = new Date(String(contract.end_date) + "T00:00:00Z");
      const contractStart = new Date(String(contract.start_date) + "T00:00:00Z");
      const pFirst        = new Date(prepaidFirstOfMonth + "T00:00:00Z");
      const pLast         = new Date(prepaidLastOfMonth  + "T00:00:00Z");

      let prepaidRentAmount: number;
      if (contractEnd < pFirst) {
        prepaidRentAmount = 0; // contract ends before next month — nothing to bill
      } else {
        const billStart   = contractStart > pFirst ? contractStart : pFirst;
        const billEnd     = contractEnd   < pLast  ? contractEnd   : pLast;
        const billableDays = Math.floor((billEnd.getTime() - billStart.getTime()) / 86400000) + 1;
        prepaidRentAmount = billableDays >= prepaidDaysInMonth
          ? baseAmount
          : Math.round((baseAmount / prepaidDaysInMonth) * billableDays);
      }

      if (prepaidRentAmount <= 0) {
        result.skipped++;
        continue;
      }

      // ── 4. Recurring add-ons for the prepaid month ─────────────────────
      // addons are pre-fetched in bulk before the loop — no per-contract DB query needed
      const taxPercentage = Number(contract.tax_percentage || 18);
      const addons = addonsByContractId.get(cid) ?? null;

      let addonsSubtotal = 0;
      const addonLineItems: { description: string; amount: number; note?: string }[] = [];
      for (const addon of (addons ?? [])) {
        const aFrom = new Date(addon.effective_from + "T00:00:00Z");
        const aUntil = addon.effective_until ? new Date(addon.effective_until + "T00:00:00Z") : null;
        const billStart = aFrom > pFirst ? aFrom : pFirst;
        const billEnd   = (aUntil && aUntil < pLast) ? aUntil : pLast;
        const billDays  = Math.floor((billEnd.getTime() - billStart.getTime()) / 86400000) + 1;
        const addonAmt  = billDays >= prepaidDaysInMonth
          ? addon.amount
          : Math.round((addon.amount / prepaidDaysInMonth) * billDays * 100) / 100;
        addonLineItems.push({
          description: addon.description,
          amount: addonAmt,
          ...(billDays < prepaidDaysInMonth ? { note: `Pro-rated ${billDays}/${prepaidDaysInMonth} days` } : {}),
        });
        addonsSubtotal += addonAmt;
      }

      const totalPrepaidSubtotal = prepaidRentAmount + addonsSubtotal;
      const combinedCgst  = Math.round(totalPrepaidSubtotal * (taxPercentage / 200));
      const combinedSgst  = Math.round(totalPrepaidSubtotal * (taxPercentage / 200));
      const combinedTax   = combinedCgst + combinedSgst;
      const combinedTotal = totalPrepaidSubtotal + combinedTax;

      // ── Dry run: record what WOULD be billed, write/dispatch nothing ──────
      if (opts.dryRun) {
        const addonNote = addonsSubtotal > 0 ? ` + ₹${addonsSubtotal.toLocaleString("en-IN")} add-ons` : "";
        const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || undefined;
        // Build line-item breakdown for the expandable detail view
        const previewLineItems: { description: string; amount: number; note?: string }[] = [
          {
            description: `Monthly rent${contract.seats ? ` (${contract.seats} seat${Number(contract.seats) > 1 ? "s" : ""})` : ""}`,
            amount: prepaidRentAmount,
            ...(prepaidRentAmount < baseAmount ? { note: `Pro-rated (contract ends mid-month)` } : {}),
          },
          ...addonLineItems,
        ];
        result.preview.push({
          contract_number: contractNumber,
          customer_name: customerName,
          type: "rent",
          period_label: monthLabel(prepaid.month, prepaid.year),
          subtotal: totalPrepaidSubtotal,
          tax_amount: combinedTax,
          cgst_amount: combinedCgst,
          sgst_amount: combinedSgst,
          total_amount: combinedTotal,
          line_items: previewLineItems,
          note: prepaidRentAmount < baseAmount
            ? `Prorated (contract ends mid-month) · CGST+SGST${addonNote}`
            : `Full month · CGST+SGST${addonNote}`,
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

      const lineItems = [{
        type: "prepaid_rent" as const,
        label: `Prepaid Rent — ${monthLabel(prepaid.month, prepaid.year)}`,
        items: [
          {
            description: `Monthly rent${contract.seats ? ` (${contract.seats} seat${Number(contract.seats) > 1 ? "s" : ""})` : ""}`,
            amount: prepaidRentAmount,
          },
          ...addonLineItems,
        ],
        subtotal: totalPrepaidSubtotal,
      }];

      // ── 5. Insert statement as draft ────────────────────────────────────
      const { data: stmt, error: insertErr } = await adminSupabase
        .from("billing_statements")
        .insert({
          contract_id:         cid,
          lead_id:             contract.lead_id,
          period_start:        prepaidFirstOfMonth,
          period_end:          prepaidLastOfMonth,
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
          line_items:          lineItems,
          prepaid_month:       prepaid.month,
          prepaid_year:        prepaid.year,
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
        const [py, pm, pd] = prepaidFirstOfMonth.split("-").map(Number);
        const gstDueDate = new Date(Date.UTC(py, pm - 1, pd + 7)).toISOString().slice(0, 10);
        await adminSupabase.from("billing_statements").update({ due_date: gstDueDate }).eq("id", stmtId);
      }
      const dispatchResult = isGstDirect
        ? await dispatchGstDirect(adminSupabase, stmtId, null, [])
        : await dispatchProforma(adminSupabase, stmtId, null, []);

      if (dispatchResult.noContact) {
        result.noContact.push(contractNumber);
      }

      // Was the proforma actually delivered? Only true when a channel produced
      // something the client can act on (email sent OR a payment link exists).
      // A no-contact or failed dispatch must NOT count as delivered — otherwise
      // the quarterly anchor advances and the unbilled quarter is skipped forever.
      const delivered =
        dispatchResult.success &&
        !dispatchResult.noContact &&
        (Boolean(dispatchResult.emailedTo) || Boolean(dispatchResult.razorpayLinkUrl));

      // ── 8. Advance quarterly next_billing_date (only on confirmed delivery) ──
      // Anchor on year+month and clamp the day to the target month's length so a
      // 30th/31st billing day never drifts via JS Date month-overflow (e.g. Nov 30
      // + 3 months would otherwise roll into March). Clamping keeps the anchor stable.
      if (contract.billing_cycle === "quarterly" && delivered) {
        const nbd = new Date(String(contract.next_billing_date) + "T00:00:00Z");
        const origDay = nbd.getUTCDate();
        const absMonth = nbd.getUTCMonth() + 3;
        const targetYear = nbd.getUTCFullYear() + Math.floor(absMonth / 12);
        const targetMonth = ((absMonth % 12) + 12) % 12;
        const daysInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
        const clampedDay = Math.min(origDay, daysInTarget);
        const advanced = new Date(Date.UTC(targetYear, targetMonth, clampedDay));
        await adminSupabase
          .from("contracts")
          .update({ next_billing_date: advanced.toISOString().slice(0, 10) })
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
 * Generate DRAFT usage statements for the CURRENT (target) month.
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
 */
export async function generateUsageStatements(
  supabase: SupabaseClient,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const now = istNow();
  const targetMonth = opts.month ?? now.getMonth() + 1;
  const targetYear  = opts.year  ?? now.getFullYear();

  const daysInMonth  = new Date(targetYear, targetMonth, 0).getDate();
  const firstOfMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const lastOfMonth  = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${daysInMonth}`;

  const periodId = await ensureAccountingPeriod(supabase, targetMonth, targetYear);

  const result: GenerateResult = {
    month: targetMonth, year: targetYear,
    generated: 0, skipped: 0, errors: [],
    statementIds: [], noContact: [], quarterlySkipped: [], superseded: [], alreadySent: [], preview: [],
  };

  // Fetch active contracts
  let contractsQuery = supabase
    .from("contracts")
    .select(`
      id, contract_number, total_amount, subtotal, tax_percentage,
      billing_cycle, start_date, end_date, lead_id,
      lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, state, gst_number)
    `)
    .in("status", ["active", "renewal_in_progress"])
    .lte("start_date", lastOfMonth)
    .gte("end_date", firstOfMonth);

  if (opts.contractId) contractsQuery = contractsQuery.eq("id", opts.contractId);
  const { data: contracts } = await contractsQuery;
  if (!contracts || contracts.length === 0) return result;

  const contractIds = contracts.map((c) => c.id as string);

  // Idempotency partition (same model as the rent generator):
  //   alreadySent  → covering usage/combined statement has been dispatched/paid → SKIP
  //   supersedable → unsent covering combined/usage draft → VOID + replace fresh
  // Note: a covering statement for usage is type usage|combined with
  // period_start = first-of-current-month (the month whose usage we're billing).
  const { data: coveringStmts } = await supabase
    .from("billing_statements")
    .select("id, contract_id, statement_number, proforma_sent_at, gst_invoice_number, billing_payments:billing_payments(id)")
    .in("contract_id", contractIds)
    .eq("period_start", firstOfMonth)
    .in("statement_type", ["usage", "combined"])
    .is("voided_at", null);

  const alreadySent = new Set<string>();
  const supersedable = new Map<string, { id: string; statement_number: string }>();
  for (const s of (coveringStmts || []) as Array<{
    id: string; contract_id: string; statement_number: string;
    proforma_sent_at: string | null; gst_invoice_number: string | null;
    billing_payments: { id: string }[];
  }>) {
    const wasSentOrPaid = !!s.proforma_sent_at || !!s.gst_invoice_number || (s.billing_payments?.length ?? 0) > 0;
    if (wasSentOrPaid) alreadySent.add(s.contract_id);
    else if (!supersedable.has(s.contract_id)) supersedable.set(s.contract_id, { id: s.id, statement_number: s.statement_number });
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
  if (billable.length === 0) return result;

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
      .in("contract_id", billable)
      .or(usageOrFilter)
      .gte("charge_date", firstOfMonth)
      .lte("charge_date", lastOfMonth),

    supabase
      .from("facility_usage_records")
      .select("contract_id, contract_facility_id, quantity_used, free_quota_applied, billable_quantity, unit_price, total_charge")
      .in("contract_id", billable)
      .eq("accounting_period_id", periodId ?? ""),

    supabase
      .from("service_usage_records")
      .select("id, contract_id, service_id, quantity_used, quota_snapshot, overage_quantity, overage_rate_snapshot, amount, is_billed")
      .in("contract_id", billable)
      .eq("period_year", targetYear)
      .eq("period_month", targetMonth)
      .or(serviceOrFilter),

    supabase
      .from("bookings")
      .select("id, booking_number, contract_id, space_id, booking_date, start_time, end_time, duration_hours, pricing_model, hourly_rate, total_amount, quantity, payment_status, status, space:spaces!bookings_space_id_fkey(name)")
      .in("contract_id", billable)
      .eq("customer_type", "contract_holder")
      .in("status", ["confirmed", "checked_in", "checked_out"])
      .gte("booking_date", firstOfMonth)
      .lte("booking_date", lastOfMonth),
  ]);

  type UsageRow = { id: string; contract_id: string; description: string; quantity: number; unit_price: number; total: number };
  type FacilityRow = { contract_id: string; contract_facility_id: string; quantity_used: number; free_quota_applied: number; billable_quantity: number; unit_price: number; total_charge: number };
  type ServiceRow = { id: string; contract_id: string; service_id: string; overage_quantity: number; overage_rate_snapshot: number; amount: number };
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

    if (alreadySent.has(cid)) {
      result.alreadySent.push(contractNumber);
      result.skipped++;
      continue;
    }
    const toSupersede = supersedable.get(cid); // already voided above in LIVE mode

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

      // Zero gate — skip if nothing chargeable
      if (totalUsage <= 0 && usageCharges.length === 0 && facilityRecs.filter(f => Number(f.billable_quantity) > 0).length === 0 && serviceRecs.filter(s => Number(s.overage_quantity) > 0).length === 0) {
        result.skipped++;
        continue;
      }

      // GST
      const taxPercentage = Number(contract.tax_percentage || 18);
      const buyerState    = (lead?.state || "").toLowerCase().trim();
      // Place of supply is always Tamil Nadu — service rendered at TWV premises (always CGST+SGST)
      const isInterstate = false;
      let cgst = 0, sgst = 0;
      const igst = 0;
      cgst = Math.round(totalUsage * (taxPercentage / 200) );
        sgst = Math.round(totalUsage * (taxPercentage / 200) );
      const taxAmount   = cgst + sgst + igst;
      const totalAmount = totalUsage + taxAmount;

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
          note: `${cats || "usage"} · ${isInterstate ? "IGST" : "CGST+SGST"} · draft for review`,
          supersedes: toSupersede?.statement_number,
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
              billable: Number(f.billable_quantity), rate: Number(f.unit_price),
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
              overage: Number(s.overage_quantity), rate: Number(s.overage_rate_snapshot),
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
          line_items:           lineItems,
          prepaid_month:        null,
          prepaid_year:         null,
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

    } catch (err) {
      result.errors.push(`${contractNumber}: ${String(err)}`);
    }
  }

  return result;
}

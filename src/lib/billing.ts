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
}

export interface GenerateResult {
  month: number;
  year: number;
  generated: number;
  skipped: number;
  errors: string[];
  /** IDs of generated statements — used by callers that want to email. */
  statementIds: string[];
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

/** Advance month by 1, wrapping year */
function nextMonth(month: number, year: number): { month: number; year: number } {
  return month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
}

/**
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
    .eq("status", "active")
    .lte("start_date", lastOfMonth)
    .gte("end_date", firstOfMonth);

  if (opts.contractId) contractsQuery = contractsQuery.eq("id", opts.contractId);

  const { data: contracts } = await contractsQuery;

  const result: GenerateResult = {
    month: targetMonth, year: targetYear,
    generated: 0, skipped: 0, errors: [], statementIds: [],
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
          prepaidRentAmount = Math.round((baseAmount / prepaidDaysInMonth) * billableDays * 100) / 100;
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
      const isInterstate = buyerState !== "" && buyerState !== "tamil nadu" && buyerState !== "tn";

      let cgst = 0, sgst = 0, igst = 0;
      if (isInterstate) {
        igst = Math.round(subtotal * (taxPercentage / 100) * 100) / 100;
      } else {
        cgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
        sgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
      }
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

      result.generated++;
      if (statement?.id) result.statementIds.push(statement.id as string);
    } catch (err) {
      result.errors.push(`${contract.contract_number}: ${String(err)}`);
    }
  }

  return result;
}

/**
 * Monthly billing — shared statement-generation logic.
 *
 * Used by:
 *   • /api/billing/auto-generate          (cron, runs 1st of every month)
 *   • /api/billing/auto-generate (POST)   (manual trigger from UI)
 *   • /api/contracts/[id] PATCH           (when a contract flips to "active",
 *                                          generate the current month's bill
 *                                          right away so mid-month activations
 *                                          don't have to wait for next cron)
 *
 * Why centralised: the generator is non-trivial (proration, GST split between
 * intra/inter-state, usage-charge linking, facility usage rollup) and we need
 * the exact same logic to run from at least three call sites. Keeping it here
 * means there's one source of truth.
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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

/**
 * Generate draft billing statements for active contracts whose tenure overlaps
 * the target month. Idempotent: existing statements for the period are left
 * alone (they're never duplicated).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateMonthlyStatements(
  supabase: SupabaseClient,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const now = istNow();
  const targetMonth = opts.month ?? now.getMonth() + 1;
  const targetYear = opts.year ?? now.getFullYear();

  const firstOfMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
  const lastOfMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${daysInMonth}`;

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

  // 4. Generate drafts
  for (const contract of contracts as Array<Record<string, unknown>>) {
    if (alreadyBilled.has(contract.id as string)) {
      result.skipped++;
      continue;
    }

    try {
      // Proration when a contract starts mid-month or ends mid-month
      const contractStart = new Date(String(contract.start_date) + "T00:00:00Z");
      const contractEnd = new Date(String(contract.end_date) + "T00:00:00Z");
      const monthStart = new Date(firstOfMonth + "T00:00:00Z");
      const monthEnd = new Date(lastOfMonth + "T00:00:00Z");

      const billableStart = contractStart > monthStart ? contractStart : monthStart;
      const billableEnd = contractEnd < monthEnd ? contractEnd : monthEnd;
      const billableDays = Math.floor((billableEnd.getTime() - billableStart.getTime()) / 86400000) + 1;

      const baseAmount = Number(contract.subtotal || contract.total_amount);
      let fixedAmount: number;
      if (billableDays >= daysInMonth) {
        fixedAmount = baseAmount;
      } else {
        fixedAmount = Math.round((baseAmount / daysInMonth) * billableDays * 100) / 100;
      }

      // Pending usage charges in this period
      const { data: usageCharges } = await supabase
        .from("usage_charges")
        .select("id, total")
        .eq("contract_id", contract.id)
        .eq("status", "pending")
        .gte("charge_date", firstOfMonth)
        .lte("charge_date", lastOfMonth);

      const usageAmount = (usageCharges || []).reduce(
        (s: number, c: { total: number }) => s + Number(c.total || 0), 0
      );

      // Facility usage records for this period
      let facilityAmount = 0;
      if (periodId) {
        const { data: facilityRecords } = await supabase
          .from("facility_usage_records")
          .select("total_charge")
          .eq("contract_id", contract.id)
          .eq("accounting_period_id", periodId);
        facilityAmount = (facilityRecords || []).reduce(
          (s: number, r: { total_charge: number }) => s + Number(r.total_charge || 0), 0
        );
      }

      const subtotal = fixedAmount + usageAmount + facilityAmount;
      const taxPercentage = Number(contract.tax_percentage || 18);

      // GST split — intra-state (TN) vs inter-state
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = contract.lead as any;
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

      const { data: statement, error: insertErr } = await supabase
        .from("billing_statements")
        .insert({
          contract_id: contract.id,
          lead_id: contract.lead_id,
          period_start: billableStart.toISOString().slice(0, 10),
          period_end: billableEnd.toISOString().slice(0, 10),
          fixed_amount: fixedAmount,
          usage_amount: usageAmount + facilityAmount,
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
        })
        .select("id")
        .single();

      if (insertErr) {
        result.errors.push(`${contract.contract_number}: ${insertErr.message}`);
        continue;
      }

      // Link usage charges to this statement and mark them billed
      if (usageCharges && usageCharges.length > 0 && statement) {
        const chargeIds = usageCharges.map((c: { id: string }) => c.id);
        await supabase
          .from("usage_charges")
          .update({ billing_statement_id: statement.id, status: "billed" })
          .in("id", chargeIds);
      }

      result.generated++;
      if (statement?.id) result.statementIds.push(statement.id as string);
    } catch (err) {
      result.errors.push(`${contract.contract_number}: ${String(err)}`);
    }
  }

  return result;
}

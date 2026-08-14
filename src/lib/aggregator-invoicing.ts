import type { SupabaseClient } from "@supabase/supabase-js";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";
import { dispatchProforma } from "@/lib/send-proforma";
import { MONTH_NAMES, VO_PURPOSE_LABELS } from "@/lib/constants";

export interface GenerateConsolidatedInvoiceParams {
  supabase: SupabaseClient;
  aggregatorId: string;
  periodMonth: number;
  periodYear: number;
  taxPercentage?: number;
  notes?: string;
  createdBy?: string;
  /** Explicit case selection from the Referrals list — omit to bill every
   *  currently-billable case for the aggregator (legacy "bill all"). Cases
   *  outside this aggregator or not in a billable status are silently
   *  dropped, not errored — the caller's list may be stale by the time this
   *  runs. */
  caseIds?: string[];
}

export interface GenerateConsolidatedInvoiceResult {
  invoice?: Record<string, unknown>;
  error?: string;
  status: number;
}

/**
 * Generate a consolidated monthly commission invoice for a postpaid aggregator.
 * Shared by the manual "Generate Invoice" API route and the monthly cron so the
 * pro-rating/tax math lives in exactly one place.
 */
export async function generateConsolidatedInvoice({
  supabase,
  aggregatorId,
  periodMonth,
  periodYear,
  taxPercentage = 18,
  notes,
  createdBy,
  caseIds,
}: GenerateConsolidatedInvoiceParams): Promise<GenerateConsolidatedInvoiceResult> {
  // Check for duplicate invoice
  const { data: existing } = await supabase
    .from("aggregator_invoices")
    .select("id, invoice_number")
    .eq("aggregator_id", aggregatorId)
    .eq("period_month", periodMonth)
    .eq("period_year", periodYear)
    .single();

  if (existing) {
    return {
      error: `Invoice already exists for this period: ${existing.invoice_number}`,
      status: 409,
    };
  }

  const { data: aggregator } = await supabase
    .from("aggregators")
    .select("id, name, same_state_as_twv, gst_number, billing_mode, billing_state")
    .eq("id", aggregatorId)
    .single();

  if (!aggregator) {
    return { error: "Aggregator not found", status: 404 };
  }

  // Get billable cases for this aggregator — either the explicit selection
  // from the Referrals list, or every currently-billable case (legacy "bill
  // all" behavior, still used by the monthly cron).
  let caseQuery = supabase
    .from("cases")
    .select("id, case_number, client_name, purpose, rate, tenure_months, start_date, activated_at, status")
    .eq("aggregator_id", aggregatorId)
    .in("status", ["active", "renewal_due", "invoiced", "executed"]);

  if (caseIds && caseIds.length > 0) {
    caseQuery = caseQuery.in("id", caseIds);
  }

  const { data: cases } = await caseQuery;

  if (!cases || cases.length === 0) {
    return {
      error: "No billable cases found for this aggregator in the period",
      status: 400,
    };
  }

  // Calculate line items with pro-rating
  const periodEnd = new Date(periodYear, periodMonth, 0); // Last day of month
  const totalDaysInMonth = periodEnd.getDate();
  // Plain string formatting for the stored period bounds — going through
  // Date + toISOString() here would construct a LOCAL midnight and then
  // convert to UTC, shifting the date back a day whenever the server's
  // timezone is ahead of UTC (e.g. IST).
  const periodStartStr = `${periodYear}-${String(periodMonth).padStart(2, "0")}-01`;
  const periodEndStr = `${periodYear}-${String(periodMonth).padStart(2, "0")}-${String(totalDaysInMonth).padStart(2, "0")}`;

  const lineItems = cases
    .filter((c) => c.rate && c.rate > 0)
    .map((c) => {
      let activeDays = totalDaysInMonth;
      let proRatedDays: number | undefined;

      // Pro-rate if activated mid-month
      if (c.activated_at) {
        const activatedDate = new Date(c.activated_at);
        if (
          activatedDate.getMonth() === periodMonth - 1 &&
          activatedDate.getFullYear() === periodYear
        ) {
          activeDays = totalDaysInMonth - activatedDate.getDate() + 1;
          proRatedDays = activeDays;
        }
      }

      const monthlyRate = c.rate || 0;
      const amount =
        proRatedDays !== undefined
          ? Math.round((monthlyRate / totalDaysInMonth) * activeDays * 100) / 100
          : monthlyRate;

      return {
        case_id: c.id,
        case_number: c.case_number,
        client_name: c.client_name,
        purpose: c.purpose,
        purpose_label: VO_PURPOSE_LABELS[c.purpose] || c.purpose,
        tenure_months: c.tenure_months,
        rate: monthlyRate,
        pro_rated_days: proRatedDays,
        total_days: totalDaysInMonth,
        amount,
      };
    });

  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const isInterstate = !aggregator.same_state_as_twv;
  const taxAmount = Math.round(subtotal * (taxPercentage / 100) * 100) / 100;

  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;

  if (isInterstate) {
    igstAmount = taxAmount;
  } else {
    cgstAmount = Math.round((taxAmount / 2) * 100) / 100;
    sgstAmount = Math.round((taxAmount / 2) * 100) / 100;
  }

  const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

  const { data: invoice, error: invoiceError } = await supabase
    .from("aggregator_invoices")
    .insert({
      aggregator_id: aggregatorId,
      period_month: periodMonth,
      period_year: periodYear,
      status: "draft",
      items: lineItems,
      subtotal,
      cgst_amount: cgstAmount,
      sgst_amount: sgstAmount,
      igst_amount: igstAmount,
      total_amount: totalAmount,
      is_interstate: isInterstate,
      tax_percentage: taxPercentage,
      notes,
      created_by: createdBy,
    })
    .select("*")
    .single();

  if (invoiceError) {
    return { error: invoiceError.message, status: 500 };
  }

  // Feed the real AR/Ageing/Tally Inbox pipeline — aggregator_invoices stays
  // alive as the existing reconciliation record, but billing_statements is
  // what accounts actually follows up on and what payment tracking hooks into.
  const { data: statement, error: statementError } = await supabase
    .from("billing_statements")
    .insert({
      aggregator_id: aggregatorId,
      period_start: periodStartStr,
      period_end: periodEndStr,
      statement_type: "vo_aggregator_consolidated",
      created_via: "vo_aggregator_monthly",
      fixed_amount: subtotal,
      usage_amount: 0,
      subtotal,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      cgst_amount: cgstAmount,
      sgst_amount: sgstAmount,
      igst_amount: igstAmount,
      total_amount: totalAmount,
      is_interstate: isInterstate,
      place_of_supply: isInterstate ? (aggregator.billing_state || "Other") : "Tamil Nadu",
      buyer_gstin: aggregator.gst_number ?? null,
      status: "finalized",
      finalized_at: new Date().toISOString(),
      line_items: [
        {
          type: "prepaid_rent",
          label: `Virtual Office Referrals — ${MONTH_NAMES[periodMonth - 1]} ${periodYear}`,
          subtotal,
          items: lineItems.map((item) => ({
            description: `${item.case_number} — ${item.client_name} · ${item.purpose_label} · ${item.tenure_months} mo tenure${item.pro_rated_days ? ` (pro-rated ${item.pro_rated_days}/${item.total_days} days)` : ""}`,
            quantity: 1,
            rate: item.amount,
            amount: item.amount,
          })),
        },
      ],
    })
    .select("id")
    .single();

  if (statementError || !statement) {
    // aggregator_invoices row already exists and is usable on its own — log
    // and continue rather than failing the whole generate call. No sibling
    // code in this repo spans a multi-table write in a transaction (see
    // vo-renewal.ts), so a partial write here is an accepted, known risk.
    console.error("[aggregator-invoicing] Failed to create billing_statements row:", statementError?.message);
    return { invoice, status: 201 };
  }

  await supabase.from("billing_statement_cases").insert(
    lineItems.map((item) => ({
      billing_statement_id: statement.id,
      case_id: item.case_id,
      amount: item.amount,
      pro_rated_days: item.pro_rated_days ?? null,
      total_days: item.total_days ?? null,
    })),
  );

  await supabase.from("aggregator_invoices").update({ billing_statement_id: statement.id }).eq("id", invoice.id);

  const billingMode = (aggregator.billing_mode as "proforma_first" | "gst_direct" | null) ?? "gst_direct";
  const handoff = await handleStatementFinalized(supabase, statement.id, billingMode, "aggregator_monthly_invoice");

  if (billingMode === "proforma_first" && !handoff.skipLegacyDispatch) {
    await dispatchProforma(supabase, statement.id);
  }
  // gst_direct: no dispatch — statement sits in the Tally Inbox until an
  // accountant uploads the real GST invoice (upload-gst-invoice/route.ts).

  return { invoice: { ...invoice, billing_statement_id: statement.id }, status: 201 };
}

import type { SupabaseClient } from "@supabase/supabase-js";

export interface GenerateConsolidatedInvoiceParams {
  supabase: SupabaseClient;
  aggregatorId: string;
  periodMonth: number;
  periodYear: number;
  taxPercentage?: number;
  notes?: string;
  createdBy?: string;
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
    .select("id, name, same_state_as_twv")
    .eq("id", aggregatorId)
    .single();

  if (!aggregator) {
    return { error: "Aggregator not found", status: 404 };
  }

  // Get all active cases for this aggregator in the given period
  const { data: cases } = await supabase
    .from("cases")
    .select("id, case_number, client_name, purpose, rate, tenure_months, start_date, activated_at, status")
    .eq("aggregator_id", aggregatorId)
    .in("status", ["active", "renewal_due", "invoiced", "executed"]);

  if (!cases || cases.length === 0) {
    return {
      error: "No active cases found for this aggregator in the period",
      status: 400,
    };
  }

  // Calculate line items with pro-rating
  const periodStart = new Date(periodYear, periodMonth - 1, 1);
  const periodEnd = new Date(periodYear, periodMonth, 0); // Last day of month
  const totalDaysInMonth = periodEnd.getDate();
  void periodStart;

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

  return { invoice, status: 201 };
}

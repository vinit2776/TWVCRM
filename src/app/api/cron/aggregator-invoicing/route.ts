import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { generateConsolidatedInvoice } from "@/lib/aggregator-invoicing";

/**
 * Aggregator invoicing cron — runs at 9:30 AM IST (4:00 AM UTC) on the 1st of
 * every month. Auto-generates a consolidated commission invoice, for the month
 * that just ended, for every active postpaid aggregator with billable cases.
 *
 * Staff can still generate ad-hoc/off-cycle invoices manually from the
 * aggregator's Billing tab at any time — this cron only covers the monthly case.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminSupabase = await createAdminClient();

  // The cron runs on the 1st, so it bills the month that just ended.
  const now = new Date();
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodMonth = lastMonthDate.getMonth() + 1;
  const periodYear = lastMonthDate.getFullYear();

  const results = {
    generated: [] as string[],
    skipped: [] as string[],
    errors: [] as string[],
  };

  const { data: aggregators, error: aggError } = await adminSupabase
    .from("aggregators")
    .select("id, name")
    .eq("status", "active")
    .eq("billing_method", "postpaid");

  if (aggError) {
    return NextResponse.json({ error: aggError.message }, { status: 500 });
  }

  for (const aggregator of aggregators ?? []) {
    try {
      const { invoice, error, status } = await generateConsolidatedInvoice({
        supabase: adminSupabase,
        aggregatorId: aggregator.id,
        periodMonth,
        periodYear,
      });

      if (error) {
        // "No active cases" and "already exists" are expected skip reasons,
        // not failures — only genuine errors (5xx) go into results.errors.
        if (status < 500) {
          results.skipped.push(`${aggregator.name}: ${error}`);
        } else {
          results.errors.push(`${aggregator.name}: ${error}`);
        }
        continue;
      }

      results.generated.push(`${aggregator.name} (${invoice?.invoice_number})`);
    } catch (err) {
      results.errors.push(
        `${aggregator.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return NextResponse.json({
    period: `${periodMonth}/${periodYear}`,
    ...results,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/electricity-bills/margin-report?year=2026&months=6
 *
 * Returns per-location per-month landlord cost vs customer revenue
 * for electricity bills over the last N months (default 6).
 *
 * Only includes bills in invoiced / dispatched status (excludes draft
 * and revised so partial captures don't pollute the report).
 */

export interface MarginReportRow {
  location_id: string;
  location_name: string;
  location_code: string;
  bill_month: number;
  bill_year: number;
  landlord_total: number;
  customer_total: number;
  margin: number;
  margin_pct: number | null;
  status: string;
}

export async function GET(request: NextRequest) {
  const supabase = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const months = Math.min(Math.max(parseInt(searchParams.get("months") ?? "6"), 1), 24);

  // Build list of (year, month) pairs going back N months from today (IST)
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const periods: Array<{ year: number; month: number }> = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(istNow.getFullYear(), istNow.getMonth() - i, 1);
    periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  const minYear = Math.min(...periods.map((p) => p.year));
  const minMonth = periods.find((p) => p.year === minYear)!.month;

  // Fetch all relevant bills in one query
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bills, error } = await (supabase as any)
    .from("electricity_bills")
    .select(
      "location_id, bill_month, bill_year, status, " +
        "landlord_total_amount, customer_total, reimbursement_enabled, " +
        "locations(id, name, code)",
    )
    .in("status", ["invoiced", "dispatched"])
    .or(
      `bill_year.gt.${minYear},` +
        `and(bill_year.eq.${minYear},bill_month.gte.${minMonth})`,
    )
    .order("bill_year", { ascending: false })
    .order("bill_month", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filter to only the requested (year, month) pairs
  const periodSet = new Set(periods.map((p) => `${p.year}-${p.month}`));
  const filtered = ((bills ?? []) as Array<{
    location_id: string;
    bill_month: number;
    bill_year: number;
    status: string;
    landlord_total_amount: number;
    customer_total: number | null;
    reimbursement_enabled: boolean;
    locations: { id: string; name: string; code: string };
  }>).filter((b) => periodSet.has(`${b.bill_year}-${b.bill_month}`));

  const rows: MarginReportRow[] = filtered.map((b) => {
    const landlord = b.landlord_total_amount ?? 0;
    const customer = b.reimbursement_enabled ? (b.customer_total ?? 0) : 0;
    const margin = customer - landlord;
    const margin_pct = landlord > 0 ? Math.round((margin / landlord) * 10000) / 100 : null;
    return {
      location_id: b.location_id,
      location_name: b.locations?.name ?? "",
      location_code: b.locations?.code ?? "",
      bill_month: b.bill_month,
      bill_year: b.bill_year,
      landlord_total: landlord,
      customer_total: customer,
      margin,
      margin_pct,
      status: b.status,
    };
  });

  // Summary: aggregate across all periods
  const summary = rows.reduce(
    (acc, r) => ({
      landlord_total: acc.landlord_total + r.landlord_total,
      customer_total: acc.customer_total + r.customer_total,
      margin: acc.margin + r.margin,
    }),
    { landlord_total: 0, customer_total: 0, margin: 0 },
  );
  const summary_margin_pct =
    summary.landlord_total > 0
      ? Math.round((summary.margin / summary.landlord_total) * 10000) / 100
      : null;

  return NextResponse.json({ data: rows, summary: { ...summary, margin_pct: summary_margin_pct } });
}

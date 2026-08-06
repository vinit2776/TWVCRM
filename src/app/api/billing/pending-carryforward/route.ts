import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/billing/pending-carryforward?contract_id=X&year=YYYY&month=M
 *
 * Returns unbilled usage_charges and service_usage_records for the given
 * contract that pre-date the current billing period. These are items that
 * should have been billed in a previous month but weren't.
 *
 * Used by the UsageReviewDialog to surface a carry-forward alert.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const contractId = searchParams.get("contract_id");
  const year  = parseInt(searchParams.get("year")  || "0");
  const month = parseInt(searchParams.get("month") || "0");

  if (!contractId) return NextResponse.json({ error: "contract_id is required" }, { status: 400 });
  if (!year || !month || month < 1 || month > 12) {
    return NextResponse.json({ error: "year and month (1-12) are required" }, { status: 400 });
  }

  // Anything whose charge_date falls strictly before the first day of the
  // billing month — charge_date is what determines the period a charge
  // belongs to, not created_at (which is just when the row was inserted,
  // and can trail charge_date for a backdated/corrected entry — see the
  // matching fix in usage-rollup/route.ts for the full rationale).
  const beforeDate = `${year}-${String(month).padStart(2, "0")}-01`;

  const admin = createAdminClient();

  // Unbilled ad-hoc usage charges from before this month
  const { data: charges } = await admin
    .from("usage_charges")
    .select("id, description, total, created_at, charge_date")
    .eq("contract_id", contractId)
    .eq("status", "pending")
    .is("billing_statement_id", null)
    .lt("charge_date", beforeDate);

  // Unbilled service usage records from before this period
  const { data: svcRaw } = await admin
    .from("service_usage_records")
    .select("id, service_id, period_year, period_month, amount, notes, service:service_catalog(name, printer_column)")
    .eq("contract_id", contractId)
    .eq("is_billed", false)
    .or(
      `period_year.lt.${year},and(period_year.eq.${year},period_month.lt.${month})`,
    );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serviceRecords = (svcRaw || []).map((s: any) => {
    const svcInfo = s.service as { name?: string; printer_column?: string | null } | null;
    let label = svcInfo?.name || s.notes || "Service charge";
    if (svcInfo?.printer_column === "bw")     label = "Print - B/W";
    if (svcInfo?.printer_column === "colour") label = "Print - Colour";
    return {
      id: s.id,
      description: label,
      amount: Number(s.amount || 0),
      period_year: s.period_year,
      period_month: s.period_month,
    };
  });

  return NextResponse.json({
    usage_charges: (charges || []).map((c) => ({
      id: c.id,
      description: c.description,
      amount: Number(c.total || 0),
      date: c.charge_date || c.created_at?.slice(0, 10),
    })),
    service_records: serviceRecords,
  });
}

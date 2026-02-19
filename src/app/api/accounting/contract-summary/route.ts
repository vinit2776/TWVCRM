import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — Contract billing summary for contract detail page
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const contractId = searchParams.get("contract_id");

  if (!contractId) {
    return NextResponse.json({ error: "contract_id is required" }, { status: 400 });
  }

  // 1. Get contract facilities
  const { data: facilities } = await supabase
    .from("contract_facilities")
    .select("*")
    .eq("contract_id", contractId)
    .eq("is_active", true)
    .order("name");

  // 2. Get payment history (last 6 months)
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const sixMonthsAgoStr = sixMonthsAgo.toISOString().split("T")[0];

  const { data: recentPayments } = await supabase
    .from("contract_payments")
    .select(
      "id, payment_number, amount, payment_mode, payment_date, status, gst_invoice_number, gst_invoice_status, cash_handover_status, creator:users!contract_payments_created_by_fkey(id, full_name)"
    )
    .eq("contract_id", contractId)
    .gte("payment_date", sixMonthsAgoStr)
    .order("payment_date", { ascending: false });

  // 3. Get lifetime totals
  // Total billed (recurring * months + facility usage + ad-hoc)
  const { data: contract } = await supabase
    .from("contracts")
    .select("id, start_date, monthly_membership_fee, tenure_months, status")
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // Calculate months elapsed
  const startDate = new Date(contract.start_date);
  const now = new Date();
  const monthsElapsed = Math.max(
    0,
    (now.getFullYear() - startDate.getFullYear()) * 12 +
      (now.getMonth() - startDate.getMonth()) +
      (now.getDate() >= startDate.getDate() ? 1 : 0)
  );
  const activMonths = Math.min(monthsElapsed, contract.tenure_months);
  const totalRecurring = activMonths * Number(contract.monthly_membership_fee);

  // Facility usage total (all time)
  const { data: allUsages } = await supabase
    .from("facility_usage_records")
    .select("total_charge")
    .eq("contract_id", contractId);

  const totalFacilityUsage = (allUsages || []).reduce((s, u) => s + Number(u.total_charge), 0);

  // Ad-hoc charges total (all time)
  const { data: allAdHoc } = await supabase
    .from("usage_charges")
    .select("total")
    .eq("contract_id", contractId);

  const totalAdHoc = (allAdHoc || []).reduce((s, c) => s + Number(c.total), 0);

  // Total paid (verified only, all time)
  const { data: allPayments } = await supabase
    .from("contract_payments")
    .select("amount, status")
    .eq("contract_id", contractId)
    .eq("status", "verified");

  const totalPaid = (allPayments || []).reduce((s, p) => s + Number(p.amount), 0);

  const totalBilled = totalRecurring + totalFacilityUsage + totalAdHoc;
  const totalOutstanding = Math.max(0, totalBilled - totalPaid);

  // 4. Current month charges and payments
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentPeriodStart = new Date(currentYear, currentMonth - 1, 1).toISOString().split("T")[0];
  const currentPeriodEnd = new Date(currentYear, currentMonth, 0).toISOString().split("T")[0];

  const { data: currentUsages } = await supabase
    .from("facility_usage_records")
    .select("total_charge, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(name)")
    .eq("contract_id", contractId);

  // Filter to current period
  const { data: currentPeriod } = await supabase
    .from("accounting_periods")
    .select("id")
    .eq("year", currentYear)
    .eq("month", currentMonth)
    .single();

  const currentFacilityTotal = currentPeriod
    ? (currentUsages || []).reduce((s, u) => s + Number(u.total_charge), 0)
    : 0;

  const { data: currentAdHoc } = await supabase
    .from("usage_charges")
    .select("total")
    .eq("contract_id", contractId)
    .gte("charge_date", currentPeriodStart)
    .lte("charge_date", currentPeriodEnd);

  const currentAdHocTotal = (currentAdHoc || []).reduce((s, c) => s + Number(c.total), 0);

  const currentMonthCharges = Number(contract.monthly_membership_fee) + currentFacilityTotal + currentAdHocTotal;

  const { data: currentPayments } = await supabase
    .from("contract_payments")
    .select("amount")
    .eq("contract_id", contractId)
    .eq("status", "verified")
    .gte("payment_date", currentPeriodStart)
    .lte("payment_date", currentPeriodEnd);

  const currentMonthPaid = (currentPayments || []).reduce((s, p) => s + Number(p.amount), 0);

  return NextResponse.json({
    data: {
      facilities: facilities || [],
      recent_payments: recentPayments || [],
      lifetime: {
        total_recurring: totalRecurring,
        total_facility_usage: totalFacilityUsage,
        total_ad_hoc: totalAdHoc,
        total_billed: totalBilled,
        total_paid: totalPaid,
        total_outstanding: totalOutstanding,
        months_elapsed: activMonths,
      },
      current_month: {
        year: currentYear,
        month: currentMonth,
        charges: currentMonthCharges,
        paid: currentMonthPaid,
        outstanding: Math.max(0, currentMonthCharges - currentMonthPaid),
      },
    },
  });
}

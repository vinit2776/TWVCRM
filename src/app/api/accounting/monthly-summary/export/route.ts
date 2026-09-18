import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// GET — Export period summary data as JSON (client renders as PDF via html2canvas or similar)
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = createAdminClient();

  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get("year") || new Date().getFullYear().toString());
  const month = parseInt(searchParams.get("month") || (new Date().getMonth() + 1).toString());

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Fetch the summary from the main endpoint internally
  const periodStart = new Date(year, month - 1, 1).toISOString().split("T")[0];
  const periodEnd = new Date(year, month, 0).toISOString().split("T")[0];

  // Fetch period, contracts, and walk-in payments in parallel (all independent)
  const [{ data: period }, { data: contracts }, { data: walkinPayments }] = await Promise.all([
    adminSupabase
      .from("accounting_periods")
      .select("*")
      .eq("year", year)
      .eq("month", month)
      .single(),
    adminSupabase
      .from("contracts")
      .select(
        "id, contract_number, title, status, start_date, seats, total_amount, tenure_months, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)"
      )
      .lte("start_date", periodEnd)
      .in("status", ["active", "renewal_in_progress"])
      .eq("is_test_contract", false),
    adminSupabase
      .from("booking_payments")
      .select("*, booking:bookings!booking_payments_booking_id_fkey(guest_name, guest_company, customer_type)")
      .gte("created_at", `${periodStart}T00:00:00`)
      .lte("created_at", `${periodEnd}T23:59:59`)
      .eq("status", "verified"),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeContracts = (contracts || []).filter((c: any) => {
    const startDate = new Date(c.start_date);
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + c.tenure_months);
    return endDate.toISOString().split("T")[0] >= periodStart;
  });

  const contractIds = activeContracts.map((c) => c.id);

  // Fetch facility usages, contract payments, and usage charges in parallel
  // (facility usages and payments depend on period; usage charges depend on contractIds)
  const [{ data: facilityUsages }, { data: payments }, { data: usageCharges }] = await Promise.all([
    period
      ? adminSupabase
          .from("facility_usage_records")
          .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(name, unit)")
          .eq("accounting_period_id", period.id)
      : Promise.resolve({ data: [] }),
    period
      ? adminSupabase
          .from("contract_payments")
          .select("*")
          .eq("accounting_period_id", period.id)
          .eq("status", "verified")
      : Promise.resolve({ data: [] }),
    contractIds.length > 0
      ? adminSupabase
          .from("usage_charges")
          .select("*")
          .in("contract_id", contractIds)
          .gte("charge_date", periodStart)
          .lte("charge_date", periodEnd)
      : Promise.resolve({ data: [] }),
  ]);

  // Build export data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contractSummaries = activeContracts.map((contract: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usages = (facilityUsages || []).filter((u: any) => u.contract_id === contract.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adhoc = (usageCharges || []).filter((c: any) => c.contract_id === contract.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pmts = (payments || []).filter((p: any) => p.contract_id === contract.id);

    const facilityTotal = usages.reduce((s, u) => s + Number(u.total_charge), 0);
    const adhocTotal = adhoc.reduce((s, c) => s + Number(c.total), 0);
    const recurring = Number(contract.total_amount);
    const totalCharges = recurring + facilityTotal + adhocTotal;
    const totalPaid = pmts.reduce((s, p) => s + Number(p.amount), 0);

    return {
      contract_number: contract.contract_number,
      company: contract.lead?.company || `${contract.lead?.first_name} ${contract.lead?.last_name}`,
      recurring,
      facility_usage: facilityTotal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      facility_details: usages.map((u: any) => ({
        name: u.contract_facility?.name,
        unit: u.contract_facility?.unit,
        quantity: Number(u.quantity_used),
        free_quota: Number(u.free_quota_applied),
        billable: Number(u.billable_quantity),
        charge: Number(u.total_charge),
      })),
      ad_hoc_charges: adhocTotal,
      total_charges: totalCharges,
      payments: totalPaid,
      outstanding: Math.max(0, totalCharges - totalPaid),
    };
  });

  const walkinTotal = (walkinPayments || []).reduce((s, p) => s + Number(p.amount), 0);
  const grandTotalCharges = contractSummaries.reduce((s, c) => s + c.total_charges, 0);
  const grandTotalPaid = contractSummaries.reduce((s, c) => s + c.payments, 0) + walkinTotal;
  const grandOutstanding = contractSummaries.reduce((s, c) => s + c.outstanding, 0);

  // Cash summary
  const allPayments = [...(payments || [])];
  const cashPending = allPayments
    .filter((p) => p.payment_mode === "cash" && p.cash_handover_status === "pending_handover")
    .reduce((s, p) => s + Number(p.amount), 0);
  const cashHandedOver = allPayments
    .filter((p) => p.payment_mode === "cash" && p.cash_handover_status === "handed_over")
    .reduce((s, p) => s + Number(p.amount), 0);

  return NextResponse.json({
    data: {
      title: `Accounting Summary — ${monthNames[month - 1]} ${year}`,
      period_status: period?.status || "open",
      contracts: contractSummaries,
      walkin_collections: walkinTotal,
      walkin_count: (walkinPayments || []).length,
      cash_summary: {
        pending_handover: cashPending,
        handed_over: cashHandedOver,
      },
      grand_totals: {
        total_charges: grandTotalCharges,
        total_collected: grandTotalPaid,
        total_outstanding: grandOutstanding,
      },
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { computeElectricityBill, type ElectricityComputeLine } from "@/lib/electricity";

interface ContractConfigRow {
  contract_id: string;
  enabled: boolean;
  utility_ratio: number;
  generator_ratio: number;
  customer_utility_rate: number;
  customer_generator_rate: number;
  customer_gst_rate: number;
  billing_profile_id: string | null;
  contracts: {
    id: string;
    contract_number: string;
    status: string;
    activated_at: string | null;
    start_date: string;
    end_date: string;
    terminated_at: string | null;
    billing_mode: string | null;
    leads: { id: string; first_name: string; last_name: string; company: string | null } | null;
  } | null;
  electricity_billing_profiles: {
    customer_utility_pct: number;
    customer_generator_pct: number;
    utility_markup_type: "per_unit" | "percent";
    utility_markup_value: number;
    generator_markup_type: "per_unit" | "percent";
    generator_markup_value: number;
    customer_gst_rate: number;
  } | null;
}

/**
 * GET /api/electricity-bills/[id]/approval-preview
 *
 * Read-only dry run of what approve_electricity_landlord_bill() would generate —
 * same enabled-contract filter, same profile/legacy rate resolution, same
 * computeElectricityBill() math already used by the capture-time live preview
 * (src/components/billing/electricity-bills-tab.tsx). Nothing is written; this
 * exists so an approver can see the customer-side impact before committing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: bill } = await supabase
    .from("electricity_bills")
    .select("id, bill_side, location_id, bill_month, bill_year")
    .eq("id", id)
    .single();

  if (!bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  if (bill.bill_side !== "landlord") {
    return NextResponse.json({ error: "Only landlord bills have an approval preview" }, { status: 422 });
  }

  const { data: lines } = await supabase
    .from("electricity_bill_lines")
    .select("line_type, units, rate")
    .eq("electricity_bill_id", id);

  const rawLines: ElectricityComputeLine[] = (lines ?? [])
    .filter((l) => (l.line_type === "utility" || l.line_type === "generator") && l.units != null && l.rate != null)
    .map((l) => ({
      line_type: l.line_type as "utility" | "generator",
      units: Number(l.units),
      landlord_rate: Number(l.rate),
    }));

  // Weighted-avg effective landlord rate per type — shared across every
  // contract below, computed once here (mirrors the reduce computeElectricityBill
  // does internally, needed up front only to back out an equivalent markup for
  // the legacy no-profile path).
  const totalsFor = (type: "utility" | "generator") => {
    const matching = rawLines.filter((l) => l.line_type === type);
    const units = matching.reduce((s, l) => s + l.units, 0);
    const amount = matching.reduce((s, l) => s + l.units * l.landlord_rate, 0);
    return { units, rate: units > 0 ? amount / units : 0 };
  };
  const effUtility = totalsFor("utility");
  const effGenerator = totalsFor("generator");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: configs } = await (supabase as any)
    .from("contract_electricity_config")
    .select(`
      contract_id, enabled, utility_ratio, generator_ratio,
      customer_utility_rate, customer_generator_rate, customer_gst_rate,
      billing_profile_id,
      contracts(id, contract_number, status, activated_at, start_date, end_date, terminated_at, billing_mode, leads!contracts_lead_id_fkey(id, first_name, last_name, company)),
      electricity_billing_profiles(customer_utility_pct, customer_generator_pct, utility_markup_type, utility_markup_value, generator_markup_type, generator_markup_value, customer_gst_rate)
    `)
    .eq("location_id", bill.location_id)
    .eq("enabled", true);

  // Same rule as approve_electricity_landlord_bill() (00582): live contracts, or
  // an activated contract that expired/was terminated but served the bill's month.
  const monthStart = `${bill.bill_year}-${String(bill.bill_month).padStart(2, "0")}-01`;
  const monthEnd = new Date(Date.UTC(bill.bill_year, bill.bill_month, 0)).toISOString().slice(0, 10);
  const servedBillMonth = (c: NonNullable<ContractConfigRow["contracts"]>) => {
    if (!["expired", "terminated"].includes(c.status) || !c.activated_at) return false;
    const effectiveEnd = c.terminated_at && c.terminated_at.slice(0, 10) < c.end_date
      ? c.terminated_at.slice(0, 10)
      : c.end_date;
    return c.start_date <= monthEnd && effectiveEnd >= monthStart;
  };
  const enabledRows = ((configs ?? []) as ContractConfigRow[]).filter(
    (c) =>
      c.enabled &&
      c.contracts != null &&
      (["active", "renewal_in_progress"].includes(c.contracts.status) || servedBillMonth(c.contracts)),
  );

  const previews = enabledRows.map((row) => {
    const profile = row.electricity_billing_profiles;

    const utilityMarkupType = profile ? profile.utility_markup_type : "per_unit";
    const utilityMarkupValue = profile ? profile.utility_markup_value : row.customer_utility_rate - effUtility.rate;
    const generatorMarkupType = profile ? profile.generator_markup_type : "per_unit";
    const generatorMarkupValue = profile ? profile.generator_markup_value : row.customer_generator_rate - effGenerator.rate;
    const customerUtilityPct = profile ? profile.customer_utility_pct : row.utility_ratio;
    const customerGeneratorPct = profile ? profile.customer_generator_pct : row.generator_ratio;
    const customerGstRate = profile ? profile.customer_gst_rate : row.customer_gst_rate;

    const result = computeElectricityBill(
      {
        reimbursement_enabled: true,
        customer_utility_pct: customerUtilityPct,
        customer_generator_pct: customerGeneratorPct,
        utility_markup_type: utilityMarkupType,
        utility_markup_value: utilityMarkupValue,
        generator_markup_type: generatorMarkupType,
        generator_markup_value: generatorMarkupValue,
        landlord_gst_rate: 0,
        landlord_tds_rate: 0,
        customer_gst_rate: customerGstRate,
      },
      rawLines,
    );

    const lead = row.contracts?.leads ?? null;
    const customerName = lead
      ? lead.company || `${lead.first_name} ${lead.last_name}`.trim()
      : row.contracts?.contract_number ?? "—";

    // The RPC stores subtotal + gst exactly (customer_round_off is hardcoded
    // to 0, see 00323 migration) — it does NOT round to the nearest rupee the
    // way computeGstAndRounding()'s totalAmount does. Recompute the total the
    // same un-rounded way so the preview matches what actually gets created.
    const exactTotal = result.customer_subtotal + result.customer_gst.cgst + result.customer_gst.sgst;

    return {
      contract_id: row.contract_id,
      contract_number: row.contracts?.contract_number ?? "—",
      billing_mode: row.contracts?.billing_mode ?? null,
      customer_name: customerName,
      customer_utility_units: result.customer_utility_units,
      customer_generator_units: result.customer_generator_units,
      customer_utility_rate: result.customer_utility_rate,
      customer_generator_rate: result.customer_generator_rate,
      customer_subtotal: result.customer_subtotal,
      customer_cgst: result.customer_gst.cgst,
      customer_sgst: result.customer_gst.sgst,
      customer_total: exactTotal,
      gst_rate: customerGstRate,
    };
  });

  return NextResponse.json({ data: previews });
}

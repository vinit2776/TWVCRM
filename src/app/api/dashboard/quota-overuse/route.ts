import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/quota-overuse
 * Surfaces unbilled overage value: service_usage_records with
 * billing_statement_id IS NULL and amount > 0, current month.
 *
 * Access: admin, manager, accounts.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const { data, error } = await adminSupabase
    .from("service_usage_records")
    .select(
      "id, contract_id, service_id, period_year, period_month, quantity_used, quota_snapshot, overage_quantity, amount, total_with_gst, billing_statement_id, contract:contracts(contract_number, is_test_contract, lead:leads(first_name, last_name, company)), service:service_catalog(name, unit_label)"
    )
    .eq("period_year", year)
    .eq("period_month", month)
    .gt("amount", 0)
    .is("billing_statement_id", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    id: string;
    contract_id: string | null;
    overage_quantity: number | null;
    amount: number | null;
    total_with_gst: number | null;
    contract: {
      contract_number: string | null;
      is_test_contract: boolean | null;
      lead: { first_name: string; last_name: string; company: string | null } | null;
    } | null;
    service: { name: string; unit_label: string } | null;
  };

  const rows = ((data ?? []) as unknown as Row[]).filter((r) => !r.contract?.is_test_contract);

  const items = rows
    .filter((r) => r.contract_id != null)
    .map((r) => ({
      id: r.id,
      contract_number: r.contract?.contract_number ?? "—",
      customer: r.contract?.lead
        ? `${r.contract.lead.first_name} ${r.contract.lead.last_name}${
            r.contract.lead.company ? " · " + r.contract.lead.company : ""
          }`
        : "Unknown",
      service_name: r.service?.name ?? "—",
      unit_label: r.service?.unit_label ?? "",
      overage_quantity: Number(r.overage_quantity ?? 0),
      amount: Math.round(Number(r.amount ?? 0)),
      total_with_gst: Math.round(Number(r.total_with_gst ?? 0)),
    }))
    .sort((a, b) => b.total_with_gst - a.total_with_gst)
    .slice(0, 8);

  const totalUnbilled = rows.reduce((s, r) => s + Number(r.total_with_gst ?? 0), 0);
  const totalRecords = rows.length;
  const totalContracts = new Set(rows.map((r) => r.contract_id).filter(Boolean)).size;

  return NextResponse.json({
    data: {
      total_unbilled_value: Math.round(totalUnbilled),
      total_records: totalRecords,
      total_contracts: totalContracts,
      items,
    },
  });
}

/**
 * GET /api/contracts/[id]/deposit-breakdown
 *
 * The customer's whole deposit working (needed per live contract, what the
 * pool holds, balance) for the Collect balance dialog and its PDF. Read-only:
 * sends nothing to the customer.
 */

import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { loadDepositSummary } from "@/lib/deposit-summary-server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, lead_id, contract_number, start_date, end_date, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
    .eq("id", contractId)
    .maybeSingle();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  try {
    const summary = await loadDepositSummary(supabase, createAdminClient(), contract.lead_id);
    const lead = Array.isArray(contract.lead) ? contract.lead[0] : contract.lead;
    return NextResponse.json({
      data: {
        contract_number: contract.contract_number,
        start_date: contract.start_date,
        end_date: contract.end_date,
        customer_name: [lead?.first_name, lead?.last_name].filter(Boolean).join(" "),
        company: lead?.company ?? null,
        breakdown: summary.breakdown,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load breakdown" }, { status: 500 });
  }
}

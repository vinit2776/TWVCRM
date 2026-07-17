import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/billing-statements/[id]/deposit-balance — thin wrapper around
 * get_deposit_available_balance, resolving the statement's contract first.
 * Lets Record Payment (which only knows the statement, not the contract)
 * decide whether to offer "Adjustment against deposit" without threading
 * contract_id through every call site.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: statementId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("contract_id")
    .eq("id", statementId)
    .single();

  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_deposit_available_balance", {
    p_contract_id: statement.contract_id,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const balance = data?.[0] ?? {
    source_contract_id: statement.contract_id,
    source_proposal_id: null,
    deposit_collected: 0,
    committed: 0,
    available: 0,
  };

  return NextResponse.json({ data: balance });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/contracts/[id]/deposit-balance — available deposit balance for
 * this contract, walking the deposit_carried_from renewal chain. Read-only,
 * for display when opening the "Adjustment against deposit" option — the
 * actual write path (request_deposit_adjustment) re-derives this fresh
 * under a row lock, so a stale read here just means the option is shown
 * when it's about to be rejected, not a security issue.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_deposit_available_balance", {
    p_contract_id: contractId,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const balance = data?.[0] ?? {
    source_contract_id: contractId,
    source_proposal_id: null,
    deposit_collected: 0,
    committed: 0,
    available: 0,
  };

  return NextResponse.json({ data: balance });
}

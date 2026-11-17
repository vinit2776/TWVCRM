/**
 * GET /api/leads/[id]/deposit-summary
 *
 * Consolidated security-deposit picture for a customer: the pooled balance
 * (required / collected / committed / available) across every contract the
 * lead holds, plus a per-contract breakdown for transparency.
 *
 * The pool itself is computed by get_deposit_available_balance — any
 * contract of the lead yields the same pooled numbers, since the RPC
 * resolves lead_id internally (see supabase/migrations/00502_pooled_customer_deposits.sql).
 * total_required isn't returned by the RPC (it only tracks collected money),
 * so it's summed here from the already-fetched contract rows.
 */

import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { loadDepositSummary } from "@/lib/deposit-summary-server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const data = await loadDepositSummary(supabase, createAdminClient(), leadId);
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load deposit summary" }, { status: 500 });
  }
}

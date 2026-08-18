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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: contracts, error } = await supabase
    .from("contracts")
    .select("id, contract_number, status, security_deposit_amount, deposit_payment_status, deposit_payment_amount, deposit_refunded_amount, deposit_carried_from, start_date, end_date, tenure_months")
    .eq("lead_id", leadId)
    .order("created_at");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!contracts || contracts.length === 0) {
    return NextResponse.json({
      data: {
        lead_id: leadId,
        total_required: 0,
        deposit_collected: 0,
        committed: 0,
        available: 0,
        unavailable_reason: "no_deposit",
        contracts: [],
      },
    });
  }

  const admin = createAdminClient();
  const { data: balanceRows, error: balanceError } = await admin.rpc("get_deposit_available_balance", {
    p_contract_id: contracts[0].id,
  });
  if (balanceError) return NextResponse.json({ error: balanceError.message }, { status: 500 });

  const balance = balanceRows?.[0] ?? {
    deposit_collected: 0, committed: 0, available: 0, unavailable_reason: "no_deposit",
  };

  const totalRequired = contracts.reduce((sum, c) => sum + Number(c.security_deposit_amount || 0), 0);

  const breakdown = contracts.map((c) => ({
    contract_id: c.id,
    contract_number: c.contract_number,
    status: c.status,
    required: Number(c.security_deposit_amount || 0),
    collected: c.deposit_payment_status === "paid"
      ? Number(c.deposit_payment_amount || c.security_deposit_amount || 0)
      : 0,
    refunded: Number(c.deposit_refunded_amount || 0),
    is_renewal_child: !!c.deposit_carried_from,
    start_date: c.start_date,
    end_date: c.end_date,
    tenure_months: c.tenure_months,
  }));

  return NextResponse.json({
    data: {
      lead_id: leadId,
      total_required: totalRequired,
      deposit_collected: balance.deposit_collected,
      committed: balance.committed,
      available: balance.available,
      unavailable_reason: balance.unavailable_reason,
      contracts: breakdown,
    },
  });
}

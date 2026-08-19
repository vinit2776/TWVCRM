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
import { CONTRACT_QUOTA_LOCKED_STATUSES } from "@/lib/constants";

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
    .select("id, contract_number, status, proposal_id, security_deposit_amount, deposit_payment_status, deposit_payment_amount, deposit_refunded_amount, deposit_carried_from, deposit_shortfall, start_date, end_date, tenure_months")
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
        total_shortfall: 0,
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

  // A renewal doesn't add a second deposit obligation — a carried-from
  // child's own security_deposit_amount already reflects the full
  // post-escalation requirement (deposit_shortfall is only the delta above
  // the parent's). So once a parent has actually been superseded, it must
  // drop out of the required total, or the chain's requirement gets counted
  // twice. But per the house convention on CONTRACT_QUOTA_LOCKED_STATUSES
  // (src/lib/constants.ts) — "the parent isn't superseded until the renewal
  // draft is actually activated (status → renewed)" — a merely-drafted
  // renewal pointing at a parent does NOT supersede it yet. A contract
  // mid-renewal (`renewal_in_progress`) is still the customer's live
  // contract and its own requirement is still owed. Only `status ===
  // "renewed"` (the terminal state a parent reaches when its renewal
  // actually activates) means the requirement has truly moved on — used for
  // the "superseded by renewal" label, which implies a live successor.
  const supersededIds = new Set(
    contracts.filter((c) => c.status === "renewed").map((c) => c.id)
  );

  // A draft contract's own requirement stays counted for as long as the
  // draft exists — cancelling one deletes the row outright (see DELETE
  // /api/contracts/[id], draft-only), so it drops out of this query on its
  // own without any status check here. Termination is the other way a
  // requirement genuinely goes away: the customer relationship ended, so
  // whatever was required is no longer owed (refunded or written off
  // elsewhere) — unlike "renewed", there's no live successor to attribute
  // it to, so it's excluded from the total but NOT tagged "superseded".
  const excludedFromRequiredIds = new Set([
    ...supersededIds,
    ...contracts.filter((c) => c.status === "terminated").map((c) => c.id),
  ]);

  // A contract's own security_deposit_amount is only populated at
  // activation (see contracts/[id]/route.ts's activation snapshot) — at
  // creation, only security_deposit_months is set. So a draft (or any
  // pre-activation contract) always reads back 0 here today, even though
  // its linked proposal already knows the real figure and the deposit must
  // be collected before the contract can activate at all. Fall back to the
  // proposal's own requirement for any contract that hasn't activated yet —
  // each contract off a shared proposal needs its own full deposit (see
  // 00504_proposal_deposit_single_claim.sql), so two drafts off the same
  // proposal correctly each show the full amount, not a shared half.
  const unactivatedProposalIds = Array.from(new Set(
    contracts
      .filter((c) => !(CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(c.status) && c.proposal_id)
      .map((c) => c.proposal_id as string)
  ));

  const proposalRequirementById = new Map<string, number>();
  if (unactivatedProposalIds.length > 0) {
    const { data: proposalRows } = await supabase
      .from("proposals")
      .select("id, security_deposit_amount")
      .in("id", unactivatedProposalIds);
    (proposalRows ?? []).forEach((p) => proposalRequirementById.set(p.id, Number(p.security_deposit_amount || 0)));
  }

  const requiredAmountFor = (c: (typeof contracts)[number]) => {
    const isActivated = (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(c.status);
    if (isActivated || !c.proposal_id) return Number(c.security_deposit_amount || 0);
    return proposalRequirementById.get(c.proposal_id) ?? 0;
  };

  // deposit_shortfall (renewal-escalation top-up, see renew/route.ts) is a
  // real outstanding ask tracked in its own column, separate from
  // security_deposit_amount — a carried-from renewal typically snapshots
  // security_deposit_amount as 0/not_required since it collects no deposit
  // of its own, so without this the shortfall would be invisible here even
  // though it's genuinely still owed against the pool.
  const requiredFor = (c: (typeof contracts)[number]) =>
    requiredAmountFor(c) + Number(c.deposit_shortfall || 0);

  const totalRequired = contracts.reduce(
    (sum, c) => (excludedFromRequiredIds.has(c.id) ? sum : sum + requiredFor(c)),
    0
  );

  // The aggregate Shortfall tile must equal Required − Available by
  // construction, or the three tiles contradict each other on screen. It
  // used to be summed from contracts.deposit_shortfall alone — a real
  // column, but a narrower concept (only the renewal-escalation top-up
  // amount). That undercounted whenever Required also included money owed
  // for a completely uncollected contract (e.g. a second contract off a
  // shared proposal that hasn't paid its own deposit at all — nothing to do
  // with any renewal). The per-contract `shortfall` field below stays tied
  // to the real deposit_shortfall column — that one still drives the
  // "Collect Now" pre-fill for the renewal-escalation flow specifically.
  const totalShortfall = Math.max(0, totalRequired - Number(balance.available || 0));

  const breakdown = contracts.map((c) => ({
    contract_id: c.id,
    contract_number: c.contract_number,
    status: c.status,
    required: requiredFor(c),
    collected: c.deposit_payment_status === "paid"
      ? Number(c.deposit_payment_amount || c.security_deposit_amount || 0)
      : 0,
    refunded: Number(c.deposit_refunded_amount || 0),
    shortfall: Number(c.deposit_shortfall || 0),
    is_renewal_child: !!c.deposit_carried_from,
    is_superseded: supersededIds.has(c.id),
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
      total_shortfall: totalShortfall,
      unavailable_reason: balance.unavailable_reason,
      contracts: breakdown,
    },
  });
}

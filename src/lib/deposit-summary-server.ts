/**
 * The customer's consolidated deposit picture: the pool (collected, committed,
 * available), what every live contract requires, the shortfall, and the
 * customer-readable breakdown. One place so the lead profile, the contract
 * and proposal pages, the Collect balance dialog, the payment-link email and
 * the PDF can never disagree.
 *
 * `db` reads contracts / proposals (pass the user's client to keep RLS);
 * `admin` calls the pool RPC and reads top-ups.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONTRACT_QUOTA_LOCKED_STATUSES } from "@/lib/constants";
import { contractDepositRequirement, depositShortfall } from "@/lib/deposit-requirement";
import { buildDepositBreakdown } from "@/lib/deposit-breakdown";

export async function loadDepositSummary(db: SupabaseClient, admin: SupabaseClient, leadId: string) {
  const { data: contracts, error } = await db
    .from("contracts")
    .select("id, contract_number, status, proposal_id, security_deposit_amount, security_deposit_months, subtotal, total_amount, deposit_payment_status, deposit_payment_amount, deposit_refunded_amount, deposit_carried_from, deposit_shortfall, start_date, end_date, tenure_months")
    .eq("lead_id", leadId)
    .order("created_at");
  if (error) throw new Error(error.message);

  if (!contracts || contracts.length === 0) {
    return {
      lead_id: leadId, total_required: 0, deposit_collected: 0, committed: 0, available: 0,
      total_shortfall: 0, unavailable_reason: "no_deposit", contracts: [],
      breakdown: buildDepositBreakdown({ contracts: [], excludedIds: new Set(), requiredFor: () => 0, paidTopups: [], committed: 0, available: 0 }),
    };
  }

  const { data: balanceRows, error: balanceError } = await admin.rpc("get_deposit_available_balance", {
    p_contract_id: contracts[0].id,
  });
  if (balanceError) throw new Error(balanceError.message);

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
    const { data: proposalRows } = await db
      .from("proposals")
      .select("id, security_deposit_amount")
      .in("id", unactivatedProposalIds);
    (proposalRows ?? []).forEach((p) => proposalRequirementById.set(p.id, Number(p.security_deposit_amount || 0)));
  }

  // One rule: a live contract (active, or mid-renewal) requires its whole
  // deposit. Required is the sum of those, Available is what the customer's
  // pool holds, and the shortfall is the difference. The renewal-escalation
  // top-up (deposit_shortfall) is no longer added on top: it only measured
  // the rate increase and assumed the parent's deposit had been collected in
  // full, so it disagreed with this total whenever it hadn't been.
  const requiredFor = (c: (typeof contracts)[number]) =>
    contractDepositRequirement(
      c,
      c.proposal_id ? proposalRequirementById.get(c.proposal_id) ?? 0 : null,
    );

  const totalRequired = contracts.reduce(
    (sum, c) => (excludedFromRequiredIds.has(c.id) ? sum : sum + requiredFor(c)),
    0
  );

  const totalShortfall = depositShortfall(totalRequired, Number(balance.available || 0));

  // A top-up lands in the customer's pool whichever contract it is raised on,
  // so the pool's shortfall is attached to the newest live contract for the
  // Collect Now button.
  const collectOnId = [...contracts].reverse().find((c) => !excludedFromRequiredIds.has(c.id))?.id;

  const breakdown = contracts.map((c) => ({
    contract_id: c.id,
    contract_number: c.contract_number,
    status: c.status,
    required: requiredFor(c),
    collected: c.deposit_payment_status === "paid"
      ? Number(c.deposit_payment_amount || c.security_deposit_amount || 0)
      : 0,
    refunded: Number(c.deposit_refunded_amount || 0),
    shortfall: c.id === collectOnId ? totalShortfall : 0,
    is_renewal_child: !!c.deposit_carried_from,
    is_superseded: supersededIds.has(c.id),
    start_date: c.start_date,
    end_date: c.end_date,
    tenure_months: c.tenure_months,
  }));

  const { data: topupRows } = await admin
    .from("deposit_topups")
    .select("amount, category")
    .eq("source_lead_id", leadId)
    .eq("status", "paid");

  const breakdownDetail = buildDepositBreakdown({
    contracts,
    excludedIds: excludedFromRequiredIds,
    requiredFor,
    paidTopups: (topupRows ?? []).map((t) => ({ amount: Number(t.amount), category: String(t.category) })),
    committed: Number(balance.committed || 0),
    available: Number(balance.available || 0),
  });

  return {
    lead_id: leadId,
    total_required: totalRequired,
    deposit_collected: balance.deposit_collected,
    committed: balance.committed,
    available: balance.available,
    total_shortfall: totalShortfall,
    unavailable_reason: balance.unavailable_reason,
    contracts: breakdown,
    breakdown: breakdownDetail,
  };
}

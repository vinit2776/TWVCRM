-- A proposal is a configuration template that can, in edge cases, spawn more
-- than one contract (e.g. two separate desks quoted and activated off one
-- shared proposal). Today proposals.deposit_payment_status is a single flag
-- with no concept of "consumed" — every contract activated off the same
-- proposal_id independently passes the activation gate and independently
-- snapshots the SAME collected deposit as its own, silently letting one real
-- payment satisfy N separate contracts' deposit requirements.
--
-- This column marks which contract has "claimed" the proposal's collected
-- deposit. Only the claimant may snapshot the proposal's payment fields as
-- paid at activation (see contracts/[id]/route.ts); any other contract
-- activated off the same proposal gets its own requirement (still derived
-- from the proposal's rate/tenure) but starts at deposit_payment_status =
-- 'pending' and needs its own separate collection.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_claimed_by_contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL;

-- One-time backfill: attribute every already-paid proposal's deposit to the
-- earliest-activated contract that used it, so existing single-contract
-- proposals (the overwhelming majority) aren't treated as "unclaimed" going
-- forward — that would let a legitimate second contract from an unrelated
-- future re-activation-adjacent path get misread as the rightful claimant.
-- Idempotent (WHERE deposit_claimed_by_contract_id IS NULL) and touches
-- proposals only — no contract data changes.
UPDATE proposals p
SET deposit_claimed_by_contract_id = sub.contract_id
FROM (
  SELECT DISTINCT ON (proposal_id) proposal_id, id AS contract_id
  FROM contracts
  WHERE proposal_id IS NOT NULL AND activated_at IS NOT NULL
  ORDER BY proposal_id, activated_at ASC
) sub
WHERE p.id = sub.proposal_id
  AND p.deposit_payment_status = 'paid'
  AND p.deposit_claimed_by_contract_id IS NULL;

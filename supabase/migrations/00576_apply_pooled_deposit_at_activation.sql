-- Let sales / managers apply a customer's already-collected (pooled) security
-- deposit to a NEW contract at activation, instead of needing an admin override.
--
-- Background: a proposal's collected deposit belongs to the first contract that
-- claims it (00504). When a contract is replaced from the same proposal (e.g. a
-- term change), the replacement can't claim the same deposit and the activation
-- gate reports "security deposit not collected" — even though the customer's
-- pool (00502) still holds the money, on the now-terminated predecessor. The
-- pool is already the source of truth for "does this customer have enough
-- deposit on hand" (Required vs Available on the customer profile); this
-- migration lets activation consult it, via an explicit, audited "apply" step.
--
-- No money moves and nothing is added to "collected": the deposit stays
-- recorded on the contract that received it. Pool arithmetic already treats a
-- live contract's requirement as covered by the pool (shortfall = required -
-- available), so recording the applied amount on the activating contract is
-- all the gate needs. Partial coverage is allowed — the rest shows up as
-- shortfall on the customer's deposit summary.
--
-- Rollback: ALTER TABLE contracts DROP COLUMN deposit_pool_applied_amount,
-- DROP COLUMN deposit_pool_applied_at, DROP COLUMN deposit_pool_applied_by;
-- DROP FUNCTION apply_pooled_deposit_to_contract(UUID, UUID);
-- DROP FUNCTION compute_pooled_deposit_applicable(UUID);

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deposit_pool_applied_amount DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS deposit_pool_applied_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_pool_applied_by     UUID REFERENCES users(id);


-- Read-only: how much of the customer's pooled deposit could be applied to this
-- contract right now, and why not if zero. Shared by the preview endpoint and
-- the apply RPC so the two can never disagree.
--
-- other_required mirrors GET /api/leads/[id]/deposit-summary: every other
-- contract of the customer except terminated/renewed ones, activated contracts
-- by their own security_deposit_amount, not-yet-activated ones by their
-- proposal's, plus any renewal deposit_shortfall.
CREATE OR REPLACE FUNCTION compute_pooled_deposit_applicable(p_contract_id UUID)
RETURNS TABLE(
  applicable NUMERIC,
  own_required NUMERIC,
  other_required NUMERIC,
  available NUMERIC,
  reason TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract contracts%ROWTYPE;
  v_proposal proposals%ROWTYPE;
  v_own NUMERIC;
  v_other NUMERIC;
  v_available NUMERIC;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, 'Contract not found'::TEXT;
    RETURN;
  END IF;

  IF v_contract.status NOT IN ('draft', 'sent', 'viewed', 'accepted') THEN
    RETURN QUERY SELECT 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC,
      'A deposit can only be applied before the contract is activated'::TEXT;
    RETURN;
  END IF;

  IF v_contract.deposit_carried_from IS NOT NULL OR v_contract.proposal_id IS NULL THEN
    RETURN QUERY SELECT 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC,
      'Only a new contract linked to a proposal needs this'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_proposal FROM proposals WHERE id = v_contract.proposal_id;
  v_own := COALESCE(v_proposal.security_deposit_amount, 0);

  IF COALESCE(v_proposal.security_deposit_months, 0) <= 0 OR v_own <= 0 THEN
    RETURN QUERY SELECT 0::NUMERIC, v_own, 0::NUMERIC, 0::NUMERIC, 'No security deposit is required'::TEXT;
    RETURN;
  END IF;

  -- The proposal's own paid deposit, if still unclaimed (or claimed by this
  -- contract), already covers this contract at activation. Applying the pool
  -- on top would count the same rupees twice.
  IF v_proposal.deposit_payment_status = 'paid'
     AND (v_proposal.deposit_claimed_by_contract_id IS NULL
          OR v_proposal.deposit_claimed_by_contract_id = p_contract_id) THEN
    RETURN QUERY SELECT 0::NUMERIC, v_own, 0::NUMERIC, 0::NUMERIC,
      'The proposal''s own deposit covers this contract — nothing to apply'::TEXT;
    RETURN;
  END IF;

  SELECT b.available INTO v_available FROM get_deposit_available_balance(p_contract_id) b;
  v_available := COALESCE(v_available, 0);

  SELECT COALESCE(SUM(
    CASE
      WHEN c.status IN ('active', 'renewal_in_progress', 'expired')
        THEN COALESCE(c.security_deposit_amount, 0)
      WHEN c.proposal_id IS NOT NULL
        THEN COALESCE((SELECT p.security_deposit_amount FROM proposals p WHERE p.id = c.proposal_id), 0)
      ELSE COALESCE(c.security_deposit_amount, 0)
    END + COALESCE(c.deposit_shortfall, 0)
  ), 0)
  INTO v_other
  FROM contracts c
  WHERE c.lead_id = v_contract.lead_id
    AND c.id <> p_contract_id
    AND c.status NOT IN ('terminated', 'renewed');

  RETURN QUERY SELECT
    ROUND(LEAST(v_own, GREATEST(v_available - v_other, 0)), 2),
    v_own,
    v_other,
    v_available,
    CASE WHEN v_available - v_other > 0 THEN NULL
         ELSE 'The customer has no unallocated security deposit available'
    END::TEXT;
END;
$$;


-- Records the applied amount on the contract. The advisory lock is the same one
-- request_deposit_adjustment takes, so an apply and a statement adjustment for
-- the same customer queue instead of both reading a stale balance.
-- Re-applying before activation recomputes (e.g. after a top-up) rather than
-- erroring.
CREATE OR REPLACE FUNCTION apply_pooled_deposit_to_contract(
  p_contract_id UUID,
  p_applied_by UUID
)
RETURNS TABLE(success BOOLEAN, error TEXT, applied_amount NUMERIC, own_required NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_id UUID;
  r RECORD;
BEGIN
  SELECT lead_id INTO v_lead_id FROM contracts WHERE id = p_contract_id;
  IF v_lead_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Contract not found'::TEXT, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('deposit_pool:' || v_lead_id::text));

  SELECT * INTO r FROM compute_pooled_deposit_applicable(p_contract_id);

  IF r.applicable IS NULL OR r.applicable <= 0 THEN
    RETURN QUERY SELECT FALSE, COALESCE(r.reason, 'Nothing to apply')::TEXT, 0::NUMERIC, r.own_required;
    RETURN;
  END IF;

  UPDATE contracts
  SET deposit_pool_applied_amount = r.applicable,
      deposit_pool_applied_at = NOW(),
      deposit_pool_applied_by = p_applied_by
  WHERE id = p_contract_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, r.applicable, r.own_required;
END;
$$;

REVOKE ALL ON FUNCTION compute_pooled_deposit_applicable(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION apply_pooled_deposit_to_contract(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION compute_pooled_deposit_applicable(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION apply_pooled_deposit_to_contract(UUID, UUID) TO service_role;

-- A new contract's pooled-deposit applicable amount now uses the same
-- requirement rule as the customer's deposit summary (Required = every live
-- contract's deposit; Available = the pool; unallocated = Available - the
-- other contracts' requirement).
--
-- Before: other_required read a carried-forward renewal as its snapshot (0)
-- plus only the rent-increase delta, so a live renewal looked almost free and
-- a new contract could be offered pool money the renewal still needed.
--
-- Rollback: re-run the compute_pooled_deposit_applicable definition from
-- 00576_apply_pooled_deposit_at_activation.sql.

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

  -- Same rule as GET /api/leads/[id]/deposit-summary (deposit-requirement.ts):
  -- an activated contract needs its own snapshot, or months x monthly fee when
  -- it carries its deposit forward and snapshotted nothing; a not-yet-activated
  -- one needs its proposal's figure. The renewal rent-increase delta
  -- (deposit_shortfall) is no longer added on top: it only measured the rise
  -- and left a carried-forward renewal looking nearly free.
  SELECT COALESCE(SUM(
    CASE
      WHEN c.status IN ('active', 'renewal_in_progress', 'expired') THEN
        CASE WHEN COALESCE(c.security_deposit_amount, 0) > 0 THEN c.security_deposit_amount
             ELSE ROUND(COALESCE(c.security_deposit_months, 0) * COALESCE(c.subtotal, c.total_amount, 0), 2)
        END
      WHEN c.proposal_id IS NOT NULL
        THEN COALESCE((SELECT p.security_deposit_amount FROM proposals p WHERE p.id = c.proposal_id), 0)
      ELSE COALESCE(c.security_deposit_amount, 0)
    END
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

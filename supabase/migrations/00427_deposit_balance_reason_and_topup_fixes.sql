-- Deposit adjustment: tell the UI *why* there's nothing to adjust, and fix
-- two defects in the "deposit not paid, but top-ups exist" branch that
-- 00368 introduced when it folded deposit_topups into the balance.
--
-- 1. get_deposit_available_balance now returns unavailable_reason, so the
--    Record Payment dialog can show "Adjustment against deposit" greyed out
--    with an explanation instead of silently dropping the option from the
--    list. Roughly half the contracts with open AR have no adjustable
--    deposit — a missing dropdown entry reads as "the feature is broken",
--    which is exactly how this was reported.
--
-- 2. BUG (read path): when the source proposal's deposit wasn't paid but
--    paid top-ups existed, the function returned committed = 0 and
--    available = <full top-up total>, ignoring pending/approved adjustments
--    entirely. The write path computes committed correctly, so the UI would
--    offer a balance the submit then refuses.
--
-- 3. BUG (write path): in that same branch request_deposit_adjustment did
--    v_collected := COALESCE(deposit_payment_amount, security_deposit_amount, 0)
--    + topups — adding the proposal's *uncollected* deposit amount. A single
--    ₹1 paid top-up on a contract whose ₹62,000 deposit is still 'pending'
--    would make ₹62,001 adjustable against real invoices. Both paths now
--    count the proposal's deposit only when it is actually marked paid.
--
-- No data migration: deposit_adjustments has no approved rows in production,
-- so nothing was settled through the buggy branch.

-- Return type changes, so CREATE OR REPLACE won't do.
DROP FUNCTION IF EXISTS get_deposit_available_balance(UUID);

CREATE FUNCTION get_deposit_available_balance(p_contract_id UUID)
RETURNS TABLE(
  source_contract_id UUID,
  source_proposal_id UUID,
  deposit_collected NUMERIC,
  committed NUMERIC,
  available NUMERIC,
  -- NULL when available > 0. Otherwise one of:
  --   no_proposal      — no deposit-collecting proposal on the renewal chain
  --   deposit_pending  — proposal carries a deposit amount, not yet paid
  --   no_deposit       — nothing was ever collected (waived / zero deposit)
  --   fully_committed  — collected, but already spoken for by other adjustments
  unavailable_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_contract UUID;
  v_proposal_id UUID;
  v_deposit_status TEXT;
  v_deposit_amount NUMERIC;
  v_deposit_paid_amount NUMERIC;
  v_topups NUMERIC;
  v_collected NUMERIC;
  v_committed NUMERIC;
  v_available NUMERIC;
BEGIN
  v_source_contract := resolve_deposit_source_contract(p_contract_id);

  SELECT c.proposal_id INTO v_proposal_id FROM contracts c WHERE c.id = v_source_contract;

  IF v_proposal_id IS NULL THEN
    RETURN QUERY SELECT v_source_contract, NULL::UUID, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC,
      'no_proposal'::TEXT;
    RETURN;
  END IF;

  SELECT p.deposit_payment_status, p.security_deposit_amount, p.deposit_payment_amount
  INTO v_deposit_status, v_deposit_amount, v_deposit_paid_amount
  FROM proposals p WHERE p.id = v_proposal_id;

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_topups
  FROM deposit_topups dt
  WHERE dt.source_proposal_id = v_proposal_id AND dt.status = 'paid';

  -- The proposal's own deposit counts only once it is actually marked paid.
  -- Top-ups are already money in hand, so they count regardless — a
  -- risk-buffer top-up on a contract whose deposit was waived is adjustable.
  v_collected := CASE
    WHEN v_deposit_status = 'paid' THEN COALESCE(v_deposit_paid_amount, v_deposit_amount, 0)
    ELSE 0
  END + v_topups;

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_proposal_id = v_proposal_id
    AND da.status IN ('pending_approval', 'approved');

  v_available := GREATEST(v_collected - v_committed, 0);

  RETURN QUERY SELECT v_source_contract, v_proposal_id, v_collected, v_committed, v_available,
    CASE
      WHEN v_available > 0 THEN NULL
      WHEN v_collected > 0 THEN 'fully_committed'
      WHEN v_deposit_status IS DISTINCT FROM 'paid' AND COALESCE(v_deposit_amount, 0) > 0
        THEN 'deposit_pending'
      ELSE 'no_deposit'
    END::TEXT;
END;
$$;


-- Write path: same collected-amount rule as above. Everything else is
-- unchanged from 00368 — the FOR UPDATE lock on the source proposal still
-- covers the balance check and the insert.

CREATE OR REPLACE FUNCTION request_deposit_adjustment(
  p_contract_id UUID,
  p_billing_statement_id UUID,
  p_amount NUMERIC,
  p_requested_by UUID,
  p_notify_customer BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(success BOOLEAN, error TEXT, adjustment_id UUID, available_after NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_contract UUID;
  v_proposal_id UUID;
  v_deposit_status TEXT;
  v_deposit_amount NUMERIC;
  v_deposit_paid_amount NUMERIC;
  v_topups NUMERIC;
  v_collected NUMERIC;
  v_committed NUMERIC;
  v_available NUMERIC;
  v_statement_status TEXT;
  v_statement_contract UUID;
  v_new_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'Amount must be greater than zero', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  SELECT bs.status, bs.contract_id INTO v_statement_status, v_statement_contract
  FROM billing_statements bs WHERE bs.id = p_billing_statement_id;

  IF v_statement_status IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Billing statement not found', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  IF v_statement_contract IS DISTINCT FROM p_contract_id THEN
    RETURN QUERY SELECT FALSE, 'Billing statement does not belong to this contract', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  IF v_statement_status NOT IN ('finalized', 'exported') THEN
    RETURN QUERY SELECT FALSE,
      'Statement must be finalized or exported before recording a deposit adjustment',
      NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  v_source_contract := resolve_deposit_source_contract(p_contract_id);

  SELECT c.proposal_id INTO v_proposal_id FROM contracts c WHERE c.id = v_source_contract;

  IF v_proposal_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'No deposit-collecting proposal found for this contract',
      NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  -- Lock the source proposal row for the duration of the balance check + insert
  SELECT p.deposit_payment_status, p.security_deposit_amount, p.deposit_payment_amount
  INTO v_deposit_status, v_deposit_amount, v_deposit_paid_amount
  FROM proposals p WHERE p.id = v_proposal_id
  FOR UPDATE;

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_topups
  FROM deposit_topups dt
  WHERE dt.source_proposal_id = v_proposal_id AND dt.status = 'paid';

  v_collected := CASE
    WHEN v_deposit_status = 'paid' THEN COALESCE(v_deposit_paid_amount, v_deposit_amount, 0)
    ELSE 0
  END + v_topups;

  IF v_collected <= 0 THEN
    RETURN QUERY SELECT FALSE, 'No paid deposit found for this contract', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_proposal_id = v_proposal_id
    AND da.status IN ('pending_approval', 'approved');

  v_available := v_collected - v_committed;

  IF p_amount > v_available + 0.01 THEN
    RETURN QUERY SELECT FALSE,
      format('Amount exceeds available deposit balance (available: %s)', ROUND(v_available, 2)),
      NULL::UUID, v_available;
    RETURN;
  END IF;

  INSERT INTO deposit_adjustments (
    contract_id, source_proposal_id, billing_statement_id, amount,
    status, requested_by, notify_customer
  ) VALUES (
    p_contract_id, v_proposal_id, p_billing_statement_id, p_amount,
    'pending_approval', p_requested_by, COALESCE(p_notify_customer, FALSE)
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id, (v_available - p_amount);
END;
$$;

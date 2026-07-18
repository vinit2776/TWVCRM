-- Settle a PENDING deposit top-up that was paid offline.
--
-- deposit_topups already had two entry points: the webhook
-- (mark_deposit_topup_paid, keyed on the Razorpay link) and
-- record_deposit_topup_manual, which CREATES an already-paid row for money
-- received without a link ever being sent. Neither closes the case where a
-- payment link went out and the customer then paid by NEFT/UPI/cheque
-- instead — the top-up stays 'pending' forever and keeps getting chased.
--
-- Mirrors the webhook's shortfall handling exactly, including the FOR
-- UPDATE lock ordering, so a manual settle and a late webhook for the same
-- top-up cannot both decrement the shortfall.

CREATE OR REPLACE FUNCTION mark_deposit_topup_paid_manual(
  p_topup_id UUID,
  p_payment_mode TEXT,
  p_payment_reference TEXT,
  p_proof_path TEXT,
  p_paid_by UUID
)
RETURNS TABLE(success BOOLEAN, error TEXT, topup_id UUID, contract_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topup RECORD;
  v_shortfall NUMERIC;
BEGIN
  SELECT * INTO v_topup FROM deposit_topups
  WHERE id = p_topup_id
  FOR UPDATE;

  IF v_topup IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Top-up not found', NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- Idempotency: a webhook may have landed first. Never double-decrement
  -- the shortfall.
  IF v_topup.status != 'pending' THEN
    RETURN QUERY SELECT FALSE, format('Top-up already %s', v_topup.status), v_topup.id, v_topup.contract_id;
    RETURN;
  END IF;

  IF v_topup.applies_to_shortfall THEN
    SELECT deposit_shortfall INTO v_shortfall FROM contracts WHERE id = v_topup.contract_id FOR UPDATE;
    UPDATE contracts SET deposit_shortfall = GREATEST(0, COALESCE(v_shortfall, 0) - v_topup.amount)
    WHERE id = v_topup.contract_id;
  END IF;

  UPDATE deposit_topups SET
    status = 'paid',
    paid_at = NOW(),
    collection_method = 'manual',
    payment_mode = COALESCE(p_payment_mode, payment_mode),
    payment_reference = COALESCE(p_payment_reference, payment_reference),
    proof_path = COALESCE(p_proof_path, proof_path),
    updated_at = NOW()
  WHERE id = v_topup.id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_topup.id, v_topup.contract_id;
END;
$$;

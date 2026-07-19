-- Cancel a PENDING deposit top-up.
--
-- Until now a top-up link sent by mistake (wrong amount, wrong contract,
-- customer since paid another way) could only be closed by settling it and
-- then reversing it — which fabricates a payment that never happened and
-- leaves a misleading paid→reversed pair in the audit trail. Meanwhile the
-- row keeps ageing in AR and keeps getting chased by the follow-up ladder.
--
-- Only pending rows are cancellable: a paid top-up must go through
-- reverse_deposit_topup so the shortfall restore and audit trail stay
-- correct. A cancelled top-up never touched deposit_shortfall (that only
-- happens on payment), so there is nothing to restore here.

ALTER TABLE deposit_topups
  DROP CONSTRAINT IF EXISTS deposit_topups_status_check;

ALTER TABLE deposit_topups
  ADD CONSTRAINT deposit_topups_status_check
  CHECK (status IN ('pending', 'paid', 'reversed', 'cancelled'));

ALTER TABLE deposit_topups
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

CREATE OR REPLACE FUNCTION cancel_deposit_topup(
  p_topup_id UUID,
  p_cancelled_by UUID,
  p_reason TEXT
)
RETURNS TABLE(success BOOLEAN, error TEXT, topup_id UUID, contract_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topup RECORD;
BEGIN
  SELECT * INTO v_topup FROM deposit_topups
  WHERE id = p_topup_id
  FOR UPDATE;

  IF v_topup IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Top-up not found', NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- A late webhook could have settled this between the operator opening the
  -- dialog and confirming. Paid money must be reversed, never cancelled.
  IF v_topup.status != 'pending' THEN
    RETURN QUERY SELECT
      FALSE,
      format('Only a pending top-up can be cancelled — this one is %s', v_topup.status),
      v_topup.id, v_topup.contract_id;
    RETURN;
  END IF;

  UPDATE deposit_topups SET
    status = 'cancelled',
    cancelled_by = p_cancelled_by,
    cancelled_at = NOW(),
    cancellation_reason = p_reason,
    updated_at = NOW()
  WHERE id = v_topup.id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_topup.id, v_topup.contract_id;
END;
$$;

-- Deposit adjustment: allow self-cancel
--
-- reject_deposit_adjustment previously blocked the requester from acting on
-- their own request at all, matching approve's self-approval block. But
-- unlike approval (which moves money and must never be self-authorized),
-- rejecting your OWN request is just a withdrawal — no funds move, no
-- authorization is being self-granted. Blocking it created a dead end: if
-- the requester is the only admin/manager on staff (now that admin can also
-- initiate, per the filed spec update), "awaiting a different approver" had
-- no way to resolve. Self-cancel is now allowed for the original requester
-- (any role); rejecting someone ELSE's request still requires admin/manager,
-- unchanged. approve_deposit_adjustment's self-approval block is untouched —
-- that one moves money and stays absolute.

CREATE OR REPLACE FUNCTION reject_deposit_adjustment(
  p_adjustment_id UUID,
  p_rejected_by UUID,
  p_reason TEXT
)
RETURNS TABLE(success BOOLEAN, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adj RECORD;
  v_role TEXT;
BEGIN
  SELECT * INTO v_adj FROM deposit_adjustments WHERE id = p_adjustment_id FOR UPDATE;

  IF v_adj IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Adjustment not found';
    RETURN;
  END IF;

  IF v_adj.status != 'pending_approval' THEN
    RETURN QUERY SELECT FALSE, format('Adjustment is not pending approval (status: %s)', v_adj.status);
    RETURN;
  END IF;

  -- Self-cancel (any role) is always allowed. Rejecting someone else's
  -- request still requires admin/manager.
  IF v_adj.requested_by != p_rejected_by THEN
    SELECT role INTO v_role FROM users WHERE id = p_rejected_by;
    IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
      RETURN QUERY SELECT FALSE, 'Only admin or manager can reject a deposit adjustment';
      RETURN;
    END IF;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN QUERY SELECT FALSE, 'A rejection reason is required';
    RETURN;
  END IF;

  UPDATE deposit_adjustments SET
    status = 'rejected',
    rejected_by = p_rejected_by,
    rejected_at = NOW(),
    rejection_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_adjustment_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$$;

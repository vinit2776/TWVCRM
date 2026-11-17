-- Let several deposit parts be open at once.
--
-- 00649 allowed one unpaid part per proposal. That left a deposit part-requested
-- (e.g. 40,000 of 60,000) with no way to ask for the remaining 20,000 until the
-- first part was paid or cancelled. Now any amount not yet paid or requested can
-- be asked, each part with its own link, receivable line and Report paid. The
-- minimum first slice still applies only to the very first ask.
--
-- Rollback: recreate uq_deposit_instalments_one_open (it fails while two parts
-- are open, so cancel one first) and restore request_deposit_instalment from
-- 00649.

DROP INDEX IF EXISTS uq_deposit_instalments_one_open;

CREATE OR REPLACE FUNCTION request_deposit_instalment(
  p_proposal_id UUID,
  p_amount NUMERIC,
  p_due_date DATE,
  p_internal_note TEXT,
  p_customer_message TEXT,
  p_actor UUID,
  p_override_by UUID,
  p_override_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p proposals%ROWTYPE;
  v_required NUMERIC;
  v_paid NUMERIC;
  v_balance NUMERIC;
  v_awaiting NUMERIC;
  v_pct NUMERIC;
  v_floor NUMERIC;
  v_seq INTEGER;
  v_id UUID;
  v_below BOOLEAN;
  v_override BOOLEAN := p_override_by IS NOT NULL AND COALESCE(length(btrim(p_override_reason)), 0) >= 10;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'proposal_not_found'); END IF;
  IF p.status NOT IN ('sent', 'viewed', 'accepted') THEN
    RETURN jsonb_build_object('success', false, 'error', 'proposal_not_open');
  END IF;
  IF p.deposit_payment_status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'deposit_not_pending');
  END IF;

  v_required := GREATEST(0,
    COALESCE(p.security_deposit_amount, 0) + COALESCE(p.deposit_exception_amount, 0) - COALESCE(p.deposit_credit_amount, 0));
  IF v_required <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'nothing_to_collect'); END IF;

  SELECT COALESCE(SUM(paid_amount), 0) INTO v_paid
    FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id AND status = 'paid';
  -- Several parts can be out at once, so what may still be asked is what is
  -- neither paid nor already requested.
  SELECT COALESCE(SUM(amount), 0) INTO v_awaiting
    FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id AND status = 'requested';
  v_balance := v_required - v_paid - v_awaiting;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_balance THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount_exceeds_balance', 'balance', v_balance);
  END IF;

  -- Minimum first slice. Asking for the whole balance is always fine.
  SELECT NULLIF(btrim(value), '')::NUMERIC INTO v_pct FROM app_settings WHERE key = 'deposit_min_first_part_percent';
  v_pct := COALESCE(v_pct, 25);
  v_floor := CEIL(v_required * v_pct / 100);
  v_below := v_paid = 0 AND v_awaiting = 0 AND p_amount < v_balance AND p_amount < v_floor;
  IF v_below AND NOT v_override THEN
    RETURN jsonb_build_object('success', false, 'error', 'below_floor', 'floor', v_floor, 'percent', v_pct);
  END IF;

  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id;

  INSERT INTO proposal_deposit_instalments (
    proposal_id, seq, amount, due_date, internal_note, customer_message, requested_by,
    floor_override_by, floor_override_reason
  ) VALUES (
    p_proposal_id, v_seq, p_amount, p_due_date, p_internal_note, NULLIF(btrim(COALESCE(p_customer_message, '')), ''), p_actor,
    CASE WHEN v_below THEN p_override_by END,
    CASE WHEN v_below THEN btrim(p_override_reason) END
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'instalment_id', v_id, 'seq', v_seq, 'amount', p_amount,
    'required', v_required, 'paid', v_paid, 'first_part', v_seq = 1);
END;
$$;

REVOKE ALL ON FUNCTION request_deposit_instalment(UUID, NUMERIC, DATE, TEXT, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

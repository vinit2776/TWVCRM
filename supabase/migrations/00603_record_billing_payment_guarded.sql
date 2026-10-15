-- Record a customer payment on a statement without ever over-crediting it.
--
-- The manual payment routes used to insert into billing_payments after only
-- checking that the amount was positive. Nothing compared it with what the
-- statement still owed, so recording the same receipt twice (once from the
-- Tally Inbox, again by verifying a payment report, three days later) simply
-- produced a second row and a negative balance. A read-then-insert check in
-- the route would still lose a race between two submissions, so the check and
-- the insert happen here, under a row lock on the statement.
--
-- Credit is measured exactly as src/lib/settlement.ts does: cash received plus
-- TDS deducted, against the whole-rupee statement total. One rupee of slack
-- absorbs rounding between a paisa-bearing total and a rounded receipt; it is
-- not a way to overpay.
--
-- Razorpay webhook payments deliberately do NOT go through this: that money
-- has already arrived and must be recorded whatever the statement says.
--
-- Rollback: DROP FUNCTION record_billing_payment_guarded(UUID, NUMERIC, DATE,
--   TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID); then revert the routes.

CREATE OR REPLACE FUNCTION record_billing_payment_guarded(
  p_statement_id      UUID,
  p_amount            NUMERIC,
  p_payment_date      DATE,
  p_payment_mode      TEXT,
  p_payment_reference TEXT,
  p_proof_path        TEXT,
  p_notes             TEXT,
  p_tds_amount        NUMERIC,
  p_tds_section       TEXT,
  p_recorded_by       UUID
)
RETURNS TABLE(success BOOLEAN, error_code TEXT, outstanding NUMERIC, settled NUMERIC, payment JSONB)
LANGUAGE plpgsql AS $$
DECLARE
  v_total       NUMERIC;
  v_settled     NUMERIC;
  v_remaining   NUMERIC;  -- true remainder, may be negative once overpaid
  v_outstanding NUMERIC;  -- the same, floored at zero for display
  v_credit      NUMERIC;
  v_payment     JSONB;
BEGIN
  -- Serialises concurrent payments to the same statement.
  SELECT bs.total_amount INTO v_total
  FROM billing_statements bs
  WHERE bs.id = p_statement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'STATEMENT_NOT_FOUND'::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::JSONB;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(bp.amount + COALESCE(bp.tds_amount, 0)), 0) INTO v_settled
  FROM billing_payments bp
  WHERE bp.billing_statement_id = p_statement_id;

  v_remaining   := ROUND(COALESCE(v_total, 0)) - v_settled;
  v_outstanding := GREATEST(0, v_remaining);
  v_credit      := p_amount + COALESCE(p_tds_amount, 0);

  -- The slack is measured against the true remainder, not the floored one:
  -- against the floored value a paid statement would still accept a rupee at a
  -- time, forever.
  IF v_credit > v_remaining + 1 THEN
    RETURN QUERY SELECT FALSE, 'OVERPAYMENT'::TEXT, v_outstanding, v_settled, NULL::JSONB;
    RETURN;
  END IF;

  INSERT INTO billing_payments (
    billing_statement_id, amount, payment_date, payment_mode, payment_reference,
    proof_path, notes, tds_amount, tds_section, recorded_by
  ) VALUES (
    p_statement_id, p_amount, p_payment_date, p_payment_mode, p_payment_reference,
    p_proof_path, p_notes, COALESCE(p_tds_amount, 0), p_tds_section, p_recorded_by
  )
  RETURNING to_jsonb(billing_payments.*) INTO v_payment;

  RETURN QUERY SELECT TRUE, NULL::TEXT, GREATEST(0, v_outstanding - v_credit), v_settled + v_credit, v_payment;
END;
$$;

REVOKE ALL ON FUNCTION record_billing_payment_guarded(UUID, NUMERIC, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_billing_payment_guarded(UUID, NUMERIC, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';

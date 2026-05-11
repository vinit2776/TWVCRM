-- Atomic RPCs — prevent race conditions in concurrent operations
--
-- Fix 3.3: Two RPCs that replace read-then-write patterns with
-- single atomic transactions.

-- 1. redeem_booking_credit
--    Atomically increments hours_used and flips status to 'exhausted'
--    when fully consumed. Returns FALSE if the credit is no longer
--    active or has insufficient hours (second concurrent request loses
--    the race gracefully instead of double-redeeming).

CREATE OR REPLACE FUNCTION redeem_booking_credit(
  p_credit_id UUID,
  p_hours_to_redeem NUMERIC
)
RETURNS TABLE(
  success BOOLEAN,
  new_hours_used NUMERIC,
  new_status TEXT,
  old_hours_used NUMERIC,
  credit_hours_total NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE
  v_old_hours_used NUMERIC;
  v_row RECORD;
BEGIN
  -- Capture pre-update value for audit diff
  SELECT bc.hours_used INTO v_old_hours_used
  FROM booking_credits bc WHERE bc.id = p_credit_id;

  -- Atomic update: only succeeds if credit is active AND has enough hours
  UPDATE booking_credits bc
  SET
    hours_used = bc.hours_used + p_hours_to_redeem,
    status = CASE
      WHEN bc.hours_used + p_hours_to_redeem >= bc.hours_total THEN 'exhausted'
      ELSE bc.status
    END,
    updated_at = NOW()
  WHERE bc.id = p_credit_id
    AND bc.status = 'active'
    AND bc.hours_used + p_hours_to_redeem <= bc.hours_total
  RETURNING bc.hours_used, bc.status, bc.hours_total
  INTO v_row;

  IF v_row IS NOT NULL THEN
    RETURN QUERY SELECT
      TRUE,
      v_row.hours_used,
      v_row.status,
      v_old_hours_used,
      v_row.hours_total;
  ELSE
    RETURN QUERY SELECT
      FALSE,
      NULL::NUMERIC,
      NULL::TEXT,
      v_old_hours_used,
      NULL::NUMERIC;
  END IF;
END;
$$;

-- 2. add_statement_charge_atomic
--    Inserts a usage charge AND recomputes statement totals in one
--    transaction. Prevents the race where two concurrent add-charge
--    requests each read stale totals and the last writer wins (losing
--    the other charge from the grand total).

CREATE OR REPLACE FUNCTION add_statement_charge_atomic(
  p_statement_id UUID,
  p_contract_id UUID,
  p_lead_id UUID,
  p_description TEXT,
  p_quantity NUMERIC,
  p_unit_price NUMERIC,
  p_gst_rate NUMERIC,
  p_charge_date DATE,
  p_notes TEXT,
  p_created_by UUID
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_subtotal NUMERIC;
  v_gst_amount NUMERIC;
  v_total_with_gst NUMERIC;
  v_charge_id UUID;
  v_new_usage_amount NUMERIC;
  v_fixed_amount NUMERIC;
  v_service_usage_amount NUMERIC;
  v_booking_usage_amount NUMERIC;
  v_new_subtotal NUMERIC;
  v_tax_pct NUMERIC;
  v_new_tax_amount NUMERIC;
  v_new_total NUMERIC;
  v_stmt RECORD;
  v_charge RECORD;
BEGIN
  -- Lock the statement row to prevent concurrent modifications
  SELECT * INTO v_stmt
  FROM billing_statements
  WHERE id = p_statement_id
  FOR UPDATE;

  IF v_stmt IS NULL THEN
    RETURN jsonb_build_object('error', 'Statement not found');
  END IF;
  IF v_stmt.status != 'draft' THEN
    RETURN jsonb_build_object('error', 'Charges can only be added to draft statements');
  END IF;

  -- Calculate charge amounts
  v_subtotal := ROUND(p_quantity * p_unit_price, 2);
  v_gst_amount := ROUND(v_subtotal * p_gst_rate / 100, 2);
  v_total_with_gst := ROUND(v_subtotal + v_gst_amount, 2);

  -- Insert the charge
  INSERT INTO usage_charges (
    billing_statement_id, contract_id, lead_id, description,
    quantity, unit_price, total, gst_rate, gst_amount, total_with_gst,
    charge_date, notes, status, created_by
  ) VALUES (
    p_statement_id, p_contract_id, p_lead_id, p_description,
    p_quantity, p_unit_price, v_subtotal, p_gst_rate, v_gst_amount, v_total_with_gst,
    p_charge_date, p_notes, 'billed', p_created_by
  ) RETURNING * INTO v_charge;

  -- Recompute totals from ALL charges (within this transaction)
  SELECT COALESCE(SUM(total), 0) INTO v_new_usage_amount
  FROM usage_charges
  WHERE billing_statement_id = p_statement_id;

  v_fixed_amount := COALESCE(v_stmt.fixed_amount, 0);
  v_service_usage_amount := COALESCE(v_stmt.service_usage_amount, 0);
  v_booking_usage_amount := COALESCE(v_stmt.booking_usage_amount, 0);
  v_new_subtotal := ROUND(v_fixed_amount + v_new_usage_amount + v_service_usage_amount + v_booking_usage_amount, 2);
  v_tax_pct := COALESCE(v_stmt.tax_percentage, 0);
  v_new_tax_amount := ROUND(v_new_subtotal * v_tax_pct / 100, 2);
  v_new_total := ROUND(v_new_subtotal + v_new_tax_amount, 2);

  UPDATE billing_statements SET
    usage_amount = ROUND(v_new_usage_amount, 2),
    subtotal = v_new_subtotal,
    tax_amount = v_new_tax_amount,
    total_amount = v_new_total,
    updated_at = NOW()
  WHERE id = p_statement_id;

  RETURN jsonb_build_object(
    'charge', to_jsonb(v_charge),
    'usage_amount', v_new_usage_amount,
    'subtotal', v_new_subtotal,
    'tax_amount', v_new_tax_amount,
    'total_amount', v_new_total
  );
END;
$$;

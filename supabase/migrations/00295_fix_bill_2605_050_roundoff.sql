-- ============================================================
-- Migration 00295: Clear ₹0.26 outstanding on BILL-2605-050
-- Pre-round-off era legacy balance, cleared as round-off.
-- ============================================================

DO $$
DECLARE
  v_bill_id     UUID;
  v_ceiling     NUMERIC;
  v_paid        NUMERIC;
  v_outstanding NUMERIC;
  v_admin_id    UUID;
BEGIN
  SELECT
    id,
    COALESCE(approved_amount, total_amount) + COALESCE(gst_amount, 0),
    COALESCE(amount_paid, 0)
  INTO v_bill_id, v_ceiling, v_paid
  FROM vendor_bills
  WHERE bill_number = 'BILL-2605-050';

  IF v_bill_id IS NULL THEN
    RAISE NOTICE 'BILL-2605-050 not found — skipping';
    RETURN;
  END IF;

  v_outstanding := v_ceiling - v_paid;

  IF v_outstanding <= 0 THEN
    RAISE NOTICE 'BILL-2605-050 already fully paid — skipping';
    RETURN;
  END IF;

  SELECT id INTO v_admin_id FROM users WHERE role = 'admin' LIMIT 1;

  INSERT INTO vendor_bill_payments (bill_id, amount, payment_mode, payment_date, notes, recorded_by)
  VALUES (v_bill_id, v_outstanding, 'round_off', CURRENT_DATE,
          'Sub-₹1 legacy balance cleared as round-off', v_admin_id);

  UPDATE vendor_bills
  SET amount_paid = v_ceiling, payment_status = 'paid'
  WHERE id = v_bill_id;

  RAISE NOTICE 'BILL-2605-050: cleared ₹% outstanding', v_outstanding;
END;
$$;

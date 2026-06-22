-- ============================================================
-- Migration 00297: Fix BILL-2606-064 GST split
-- Total ₹4826.20 = base ₹4087 + GST ₹736.20.
-- Bill was approved with the full amount as total_amount; correct
-- it so accounts can record payment against the right ceiling.
-- ============================================================

DO $$
DECLARE
  v_bill_id  UUID;
  v_admin_id UUID;
BEGIN
  SELECT id INTO v_bill_id FROM vendor_bills WHERE bill_number = 'BILL-2606-064';

  IF v_bill_id IS NULL THEN
    RAISE NOTICE 'BILL-2606-064 not found — skipping';
    RETURN;
  END IF;

  SELECT id INTO v_admin_id FROM users WHERE role = 'admin' LIMIT 1;

  UPDATE vendor_bills
  SET
    total_amount      = 4087.00,
    base_amount       = 4087.00,
    approved_amount   = 4087.00,
    gst_amount        = 736.20,
    gst_rate          = 0,
    gst_set_by        = v_admin_id,
    gst_set_at        = NOW(),
    gst_zero_confirmed = FALSE
  WHERE id = v_bill_id;

  RAISE NOTICE 'BILL-2606-064 corrected: base ₹4087 + GST ₹736.20 = ceiling ₹4826.20';
END;
$$;

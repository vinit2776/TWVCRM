-- When the landlord's vendor bill is rejected (entered wrongly), the customer-side electricity
-- bills computed from it are wrong too. Until now they stayed "Ready to dispatch" and could be
-- handed off to accounts. This puts the landlord electricity bill back to draft and removes the
-- customer bills that were never handed off, so Approve & Generate recalculates them from the
-- corrected figures.
--
-- Touches only bills nothing has left the building for: every customer bill must still be
-- 'invoiced' with no billing statement (dispatch is what creates the statement). Anything
-- further along is left alone and reported, never unwound here.
--
-- Rollback: DROP FUNCTION reset_electricity_bill_for_rejected_vendor_bill(UUID);
--           (rows it already reset stay as draft; re-run Approve & Generate on them)
CREATE OR REPLACE FUNCTION reset_electricity_bill_for_rejected_vendor_bill(p_vendor_bill_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vb          vendor_bills%ROWTYPE;
  v_eb          electricity_bills%ROWTYPE;
  v_deleted_ids UUID[];
BEGIN
  SELECT * INTO v_vb FROM vendor_bills WHERE id = p_vendor_bill_id;
  IF NOT FOUND OR v_vb.approval_status <> 'rejected' THEN
    RETURN jsonb_build_object('reset', false, 'reason', 'vendor_bill_not_rejected');
  END IF;

  -- Found through either side of the link; some rows only have one set.
  SELECT * INTO v_eb FROM electricity_bills
  WHERE bill_side = 'landlord' AND status <> 'revised'
    AND (id = v_vb.electricity_bill_id OR vendor_bill_id = v_vb.id)
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('reset', false, 'reason', 'no_electricity_bill');
  END IF;

  IF v_eb.status <> 'invoiced' THEN
    RETURN jsonb_build_object('reset', false, 'reason', 'not_approved', 'electricity_bill_id', v_eb.id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM electricity_bills
    WHERE landlord_bill_id = v_eb.id AND bill_side = 'customer'
      AND (status <> 'invoiced' OR billing_statement_id IS NOT NULL)
  ) THEN
    RETURN jsonb_build_object('reset', false, 'reason', 'already_handed_off', 'electricity_bill_id', v_eb.id);
  END IF;

  SELECT array_agg(id) INTO v_deleted_ids
  FROM electricity_bills
  WHERE landlord_bill_id = v_eb.id AND bill_side = 'customer';

  DELETE FROM electricity_bills WHERE landlord_bill_id = v_eb.id AND bill_side = 'customer';

  UPDATE electricity_bills
  SET status = 'draft', confirmed_at = NULL, confirmed_by = NULL
  WHERE id = v_eb.id;

  RETURN jsonb_build_object(
    'reset', true,
    'electricity_bill_id', v_eb.id,
    'deleted_customer_bill_ids', COALESCE(v_deleted_ids, '{}')
  );
END;
$$;

REVOKE ALL ON FUNCTION reset_electricity_bill_for_rejected_vendor_bill(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reset_electricity_bill_for_rejected_vendor_bill(UUID) TO service_role;

-- One-off: bills already rejected before this existed (same guard, so anything handed off is skipped).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id FROM vendor_bills
    WHERE approval_status = 'rejected' AND electricity_bill_id IS NOT NULL
  LOOP
    PERFORM reset_electricity_bill_for_rejected_vendor_bill(r.id);
  END LOOP;
END $$;

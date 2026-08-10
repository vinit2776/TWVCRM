-- 1. Prevent the same landlord bill from being captured twice at a location —
-- the real-world trigger was a double-entry that spawned a duplicate vendor
-- bill (payable) and a duplicate customer bill (receivable) for the same
-- physical invoice. Scoped to active (non-revised) landlord bills only, and
-- only enforced when a bill number is actually provided (it's optional).
CREATE UNIQUE INDEX IF NOT EXISTS idx_eb_landlord_bill_number_unique
  ON electricity_bills(location_id, landlord_bill_number)
  WHERE bill_side = 'landlord' AND status != 'revised' AND landlord_bill_number IS NOT NULL;

-- 2. Admin-only delete for a landlord or customer electricity bill, with full
-- cascade (landlord → its customer bills → their billing statements → its
-- vendor bill), so corrections no longer require a direct DB edit. Blocked
-- entirely if any payment has been recorded anywhere in the chain — this is
-- a correction tool for mis-entered data, not a way to unwind real money
-- movement (use the normal void/reversal flows for that).
--
-- Rollback: DROP FUNCTION delete_electricity_bill(UUID);
--           DROP INDEX idx_eb_landlord_bill_number_unique;
CREATE OR REPLACE FUNCTION delete_electricity_bill(p_bill_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bill                  electricity_bills%ROWTYPE;
  v_cb                     RECORD;
  v_vb                     RECORD;
  v_deleted_customer_ids   UUID[] := '{}';
  v_deleted_statement_ids  UUID[] := '{}';
  v_deleted_vendor_bill_id UUID := NULL;
BEGIN
  SELECT * INTO v_bill FROM electricity_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found: %', p_bill_id;
  END IF;

  IF v_bill.bill_side = 'customer' THEN
    -- ── Guard: block if the linked billing statement has any payment ────────
    IF v_bill.billing_statement_id IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM billing_payments WHERE billing_statement_id = v_bill.billing_statement_id)
         OR EXISTS (SELECT 1 FROM billing_statements WHERE id = v_bill.billing_statement_id AND payment_status = 'paid')
      THEN
        RAISE EXCEPTION 'Cannot delete — a payment has already been recorded on this bill''s billing statement. Reverse the payment first.';
      END IF;
    END IF;

    DELETE FROM electricity_bills WHERE id = p_bill_id;
    v_deleted_customer_ids := ARRAY[p_bill_id];

    -- Only drop the statement if nothing else still points to it (should
    -- always be true — one statement per electricity customer bill — but
    -- checked defensively rather than assumed).
    IF v_bill.billing_statement_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM electricity_bills WHERE billing_statement_id = v_bill.billing_statement_id)
    THEN
      DELETE FROM billing_statements WHERE id = v_bill.billing_statement_id;
      v_deleted_statement_ids := ARRAY[v_bill.billing_statement_id];
    END IF;

  ELSIF v_bill.bill_side = 'landlord' THEN
    -- ── Guard: block if any linked customer bill's statement has a payment ──
    FOR v_cb IN
      SELECT id, billing_statement_id FROM electricity_bills
      WHERE landlord_bill_id = p_bill_id AND bill_side = 'customer'
    LOOP
      IF v_cb.billing_statement_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM billing_payments WHERE billing_statement_id = v_cb.billing_statement_id)
           OR EXISTS (SELECT 1 FROM billing_statements WHERE id = v_cb.billing_statement_id AND payment_status = 'paid')
        THEN
          RAISE EXCEPTION 'Cannot delete — a payment has already been recorded on a linked customer bill''s billing statement (id %). Reverse the payment first.', v_cb.id;
        END IF;
      END IF;
    END LOOP;

    -- ── Guard: block if the linked vendor bill has any payment ──────────────
    IF v_bill.vendor_bill_id IS NOT NULL THEN
      SELECT * INTO v_vb FROM vendor_bills WHERE id = v_bill.vendor_bill_id;
      IF FOUND AND (COALESCE(v_vb.amount_paid, 0) > 0 OR v_vb.payment_status = 'paid') THEN
        RAISE EXCEPTION 'Cannot delete — the linked vendor bill has payments recorded. Reverse the payment first.';
      END IF;
    END IF;

    -- Sever any newer bill's historical "revised from" pointer at this one
    -- (nullable breadcrumb, safe to drop) so deleting an older revised bill
    -- never trips the self-referencing FK.
    UPDATE electricity_bills SET revised_from_id = NULL WHERE revised_from_id = p_bill_id;

    -- Collect + delete linked customer bills and their statements.
    SELECT array_agg(id), array_agg(billing_statement_id) FILTER (WHERE billing_statement_id IS NOT NULL)
      INTO v_deleted_customer_ids, v_deleted_statement_ids
      FROM electricity_bills
      WHERE landlord_bill_id = p_bill_id AND bill_side = 'customer';

    DELETE FROM electricity_bills WHERE landlord_bill_id = p_bill_id AND bill_side = 'customer';

    IF v_deleted_statement_ids IS NOT NULL THEN
      DELETE FROM billing_statements
      WHERE id = ANY(v_deleted_statement_ids)
        AND NOT EXISTS (
          SELECT 1 FROM electricity_bills eb WHERE eb.billing_statement_id = billing_statements.id
        );
    END IF;

    -- Break the circular FK (electricity_bills.vendor_bill_id <->
    -- vendor_bills.electricity_bill_id) before deleting either side.
    IF v_bill.vendor_bill_id IS NOT NULL THEN
      v_deleted_vendor_bill_id := v_bill.vendor_bill_id;
      UPDATE electricity_bills SET vendor_bill_id = NULL WHERE id = p_bill_id;
      DELETE FROM vendor_bills WHERE id = v_deleted_vendor_bill_id;
    END IF;

    DELETE FROM electricity_bills WHERE id = p_bill_id;
  ELSE
    RAISE EXCEPTION 'Unknown bill_side: %', v_bill.bill_side;
  END IF;

  RETURN jsonb_build_object(
    'deleted_bill_id', p_bill_id,
    'bill_side', v_bill.bill_side,
    'deleted_customer_bill_ids', COALESCE(v_deleted_customer_ids, '{}'),
    'deleted_billing_statement_ids', COALESCE(v_deleted_statement_ids, '{}'),
    'deleted_vendor_bill_id', v_deleted_vendor_bill_id
  );
END;
$$;

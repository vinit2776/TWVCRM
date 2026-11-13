-- ============================================================
-- Migration 00721: PO advances are applied to bills as real payment lines
--
-- Until now a new bill on a PO was credited with the whole advance the moment it was
-- created (vendor_bills.amount_paid, no payment row), and nothing remembered how much of
-- the advance had already been used. One advance could therefore be credited to every
-- bill on the PO. Now Accounts apply an advance explicitly. Each application is a
-- vendor_bill_payments row (payment_mode = 'advance') that points at the PO it came from
-- and carries the advance's own date and reference, so it shows in payment history, can be
-- reversed like any payment, and the PO can say how much of the advance is still unused.
--
-- Service role only. The API route checks the caller is accounts/admin first.
-- ============================================================

ALTER TABLE vendor_bill_payments
  ADD COLUMN IF NOT EXISTS advance_po_id UUID REFERENCES purchase_orders(id);

CREATE INDEX IF NOT EXISTS idx_vendor_bill_payments_advance_po
  ON vendor_bill_payments(advance_po_id) WHERE advance_po_id IS NOT NULL AND reversed_at IS NULL;

-- ------------------------------------------------------------
-- po_advance_unused
--
-- What is left of a PO's advance: the advance minus (a) standing advance applications and
-- (b) credit that older bills carry without any payment row (the old pre-credit). Counting
-- (b) means a PO whose advance was already credited to bills can never be applied again.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION po_advance_unused(p_po_id UUID) RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT GREATEST(
    COALESCE((SELECT advance_amount FROM purchase_orders WHERE id = p_po_id), 0)
    - COALESCE((SELECT SUM(amount) FROM vendor_bill_payments
                 WHERE advance_po_id = p_po_id AND reversed_at IS NULL), 0)
    - COALESCE((
        SELECT SUM(GREATEST(
                 b.amount_paid - COALESCE((SELECT SUM(p.amount) FROM vendor_bill_payments p
                                            WHERE p.bill_id = b.id AND p.reversed_at IS NULL), 0), 0))
          FROM vendor_bills b
         WHERE b.po_id = p_po_id
           AND b.approval_status::text NOT IN ('rejected', 'withdrawn')
      ), 0),
    0);
$$;

-- ------------------------------------------------------------
-- apply_po_advance
--
-- Locks the PO and the bill, then checks, in order:
--   NO_PO, BILL_NOT_APPROVED, ADVANCE_NOT_PROCESSED, ADVANCE_NO_REFERENCE,
--   AMOUNT_INVALID, EXCEEDS_UNUSED_ADVANCE, EXCEEDS_BILL_OUTSTANDING
-- and writes the payment row and the bill's paid amount in one transaction.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_po_advance(
  p_bill_id UUID,
  p_amount  NUMERIC,
  p_actor   UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id       UUID;
  v_po          purchase_orders%ROWTYPE;
  v_bill        vendor_bills%ROWTYPE;
  v_unused      NUMERIC(12,2);
  v_ceiling     NUMERIC(12,2);
  v_outstanding NUMERIC(12,2);
  v_new_paid    NUMERIC(12,2);
  v_status      TEXT;
  v_pay_id      UUID;
BEGIN
  SELECT po_id INTO v_po_id FROM vendor_bills WHERE id = p_bill_id;
  IF v_po_id IS NULL THEN RAISE EXCEPTION 'NO_PO'; END IF;

  -- PO first, then the bill: every apply on the same PO serialises here.
  SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_id FOR UPDATE;
  SELECT * INTO v_bill FROM vendor_bills WHERE id = p_bill_id FOR UPDATE;

  IF v_bill.approval_status::text <> 'approved' THEN RAISE EXCEPTION 'BILL_NOT_APPROVED'; END IF;
  IF v_po.advance_status <> 'processed' THEN RAISE EXCEPTION 'ADVANCE_NOT_PROCESSED'; END IF;
  IF v_po.advance_payment_reference IS NULL OR length(btrim(v_po.advance_payment_reference)) = 0 THEN
    RAISE EXCEPTION 'ADVANCE_NO_REFERENCE';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'AMOUNT_INVALID'; END IF;

  v_unused := po_advance_unused(v_po_id);
  IF p_amount > v_unused + 0.005 THEN RAISE EXCEPTION 'EXCEEDS_UNUSED_ADVANCE'; END IF;

  v_ceiling     := COALESCE(v_bill.approved_amount, v_bill.total_amount, 0) + COALESCE(v_bill.gst_amount, 0);
  v_outstanding := v_ceiling - COALESCE(v_bill.amount_paid, 0);
  IF p_amount > v_outstanding + 0.005 THEN RAISE EXCEPTION 'EXCEEDS_BILL_OUTSTANDING'; END IF;

  INSERT INTO vendor_bill_payments (
    bill_id, amount, payment_mode, payment_reference, payment_date, notes, recorded_by, advance_po_id
  ) VALUES (
    p_bill_id, p_amount, 'advance', v_po.advance_payment_reference,
    COALESCE(v_po.advance_payment_date, CURRENT_DATE),
    'Advance from ' || v_po.po_number || ' applied', p_actor, v_po_id
  ) RETURNING id INTO v_pay_id;

  v_new_paid := COALESCE(v_bill.amount_paid, 0) + p_amount;
  v_status   := CASE
                  WHEN v_new_paid >= v_ceiling - 0.01 THEN 'paid'
                  WHEN v_new_paid > 0.005 THEN 'partially_paid'
                  ELSE 'unpaid'
                END;

  UPDATE vendor_bills SET
    amount_paid       = v_new_paid,
    payment_status    = v_status::bill_payment_status,
    payment_mode      = 'advance',
    payment_reference = v_po.advance_payment_reference,
    payment_date      = COALESCE(v_po.advance_payment_date, CURRENT_DATE)
  WHERE id = p_bill_id;

  RETURN jsonb_build_object(
    'payment_id', v_pay_id,
    'po_number', v_po.po_number,
    'amount_applied', p_amount,
    'amount_paid', v_new_paid,
    'payment_status', v_status,
    'advance_unused_after', v_unused - p_amount,
    'previous', jsonb_build_object('amount_paid', v_bill.amount_paid, 'payment_status', v_bill.payment_status)
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_po_advance(UUID, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_po_advance(UUID, NUMERIC, UUID) TO service_role;
REVOKE ALL ON FUNCTION po_advance_unused(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION po_advance_unused(UUID) TO service_role;

-- ------------------------------------------------------------
-- unwind_bill_advance_credit
--
-- Takes back credit a bill shows as paid with no payment line behind it (the old pre-credit).
-- Payment lines are untouched. Admin only, reason required (checked by the route); the bill is
-- locked, the credit is whatever amount_paid exceeds the standing lines, and the status is
-- recomputed. Raises NO_CREDIT when there is nothing to take back.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION unwind_bill_advance_credit(
  p_bill_id UUID,
  p_actor   UUID,
  p_reason  TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill     vendor_bills%ROWTYPE;
  v_lines    NUMERIC(12,2);
  v_credit   NUMERIC(12,2);
  v_new_paid NUMERIC(12,2);
  v_ceiling  NUMERIC(12,2);
  v_status   TEXT;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  SELECT * INTO v_bill FROM vendor_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND'; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_lines
    FROM vendor_bill_payments WHERE bill_id = p_bill_id AND reversed_at IS NULL;
  v_credit := COALESCE(v_bill.amount_paid, 0) - v_lines;
  IF v_credit <= 0.005 THEN RAISE EXCEPTION 'NO_CREDIT'; END IF;

  v_new_paid := v_lines;
  v_ceiling  := COALESCE(v_bill.approved_amount, v_bill.total_amount, 0) + COALESCE(v_bill.gst_amount, 0);
  v_status   := CASE
                  WHEN v_new_paid >= v_ceiling - 0.01 AND v_new_paid > 0 THEN 'paid'
                  WHEN v_new_paid > 0.005 THEN 'partially_paid'
                  ELSE 'unpaid'
                END;

  UPDATE vendor_bills SET amount_paid = v_new_paid, payment_status = v_status::bill_payment_status
   WHERE id = p_bill_id;

  RETURN jsonb_build_object(
    'bill_id', p_bill_id, 'credit_removed', v_credit, 'amount_paid', v_new_paid, 'payment_status', v_status,
    'previous', jsonb_build_object('amount_paid', v_bill.amount_paid, 'payment_status', v_bill.payment_status)
  );
END;
$$;

REVOKE ALL ON FUNCTION unwind_bill_advance_credit(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION unwind_bill_advance_credit(UUID, UUID, TEXT) TO service_role;

-- Rollback:
--   DROP FUNCTION IF EXISTS unwind_bill_advance_credit(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS apply_po_advance(UUID, NUMERIC, UUID);
--   DROP FUNCTION IF EXISTS po_advance_unused(UUID);
--   DROP INDEX IF EXISTS idx_vendor_bill_payments_advance_po;
--   ALTER TABLE vendor_bill_payments DROP COLUMN IF EXISTS advance_po_id;

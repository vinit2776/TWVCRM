-- ============================================================
-- Migration 00597: Admin reversal of vendor bill payments
--
-- A recorded vendor payment used to be permanent: vendor_bill_payments has no
-- update/delete policy and no route could undo one. Reversal is a SOFT delete —
-- the row stays in history, flagged reversed — so the audit trail shows what was
-- paid and then undone, rather than a payment that silently vanished.
--
-- Every reader that sums or lists payments must ignore rows where
-- reversed_at IS NOT NULL (the RPC below keeps vendor_bills.amount_paid in step).
-- ============================================================

ALTER TABLE vendor_bill_payments
  ADD COLUMN IF NOT EXISTS reversed_at       TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reversed_by       UUID        REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reversal_reason   TEXT        DEFAULT NULL;

-- The TDS deduction taken on a payment is reversed with it.
ALTER TABLE vendor_bill_tds
  ADD COLUMN IF NOT EXISTS reversed_at       TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_bill_payments_active
  ON vendor_bill_payments(bill_id) WHERE reversed_at IS NULL;

-- ------------------------------------------------------------
-- reverse_vendor_bill_payment
--
-- Atomic under a row lock on the bill (never read-then-write for financial
-- state). Service role only: the API route checks the caller is an admin
-- before calling this.
--
-- Raises (route maps these to 4xx):
--   PAYMENT_NOT_FOUND, PAYMENT_ALREADY_REVERSED, TDS_DEPOSITED
--
-- amount_paid is DECREMENTED, not recomputed from payment rows: a PO advance
-- credit writes bill.amount_paid at creation with no payment row, so the rows
-- alone under-count it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION reverse_vendor_bill_payment(
  p_payment_id UUID,
  p_actor      UUID,
  p_reason     TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay        vendor_bill_payments%ROWTYPE;
  v_bill       vendor_bills%ROWTYPE;
  v_new_paid   NUMERIC(12,2);
  v_ceiling    NUMERIC(12,2);
  v_status     TEXT;
  v_last       vendor_bill_payments%ROWTYPE;
  v_tds_total  NUMERIC(12,2);
  v_pc_credit  NUMERIC(12,2) := 0;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT * INTO v_pay FROM vendor_bill_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;

  -- Lock the bill first, then re-read the payment, so two concurrent reversals
  -- of the same payment serialise on the bill row.
  SELECT * INTO v_bill FROM vendor_bills WHERE id = v_pay.bill_id FOR UPDATE;
  SELECT * INTO v_pay FROM vendor_bill_payments WHERE id = p_payment_id;
  IF v_pay.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_ALREADY_REVERSED'; END IF;

  -- A deposited TDS entry is tied to a filed challan; undoing the payment would
  -- leave the challan depositing tax that was never deducted.
  IF EXISTS (
    SELECT 1 FROM vendor_bill_tds
    WHERE payment_id = p_payment_id AND reversed_at IS NULL AND status = 'deposited'
  ) THEN
    RAISE EXCEPTION 'TDS_DEPOSITED';
  END IF;

  SELECT COALESCE(SUM(tds_amount), 0) INTO v_tds_total
  FROM vendor_bill_tds WHERE payment_id = p_payment_id AND reversed_at IS NULL;

  UPDATE vendor_bill_payments
     SET reversed_at = now(), reversed_by = p_actor, reversal_reason = btrim(p_reason)
   WHERE id = p_payment_id;

  UPDATE vendor_bill_tds SET reversed_at = now()
   WHERE payment_id = p_payment_id AND reversed_at IS NULL;

  -- Cash payments debited a petty cash book when they were recorded.
  IF v_pay.payment_mode = 'cash' AND v_pay.petty_cash_book_id IS NOT NULL THEN
    UPDATE petty_cash_books
       SET current_balance = current_balance + v_pay.amount
     WHERE id = v_pay.petty_cash_book_id;
    v_pc_credit := v_pay.amount;
  END IF;

  v_new_paid := GREATEST(COALESCE(v_bill.amount_paid, 0) - v_pay.amount, 0);
  v_ceiling  := COALESCE(v_bill.approved_amount, v_bill.total_amount, 0) + COALESCE(v_bill.gst_amount, 0);
  v_status   := CASE
                  WHEN v_new_paid >= v_ceiling - 0.01 AND v_new_paid > 0 THEN 'paid'
                  WHEN v_new_paid > 0.005 THEN 'partially_paid'
                  ELSE 'unpaid'
                END;

  -- The bill's denormalised "last payment" columns point at the newest payment
  -- that is still standing.
  SELECT * INTO v_last FROM vendor_bill_payments
   WHERE bill_id = v_bill.id AND reversed_at IS NULL
   ORDER BY payment_date DESC, created_at DESC LIMIT 1;

  UPDATE vendor_bills SET
    amount_paid       = v_new_paid,
    payment_status    = v_status::bill_payment_status,
    payment_mode      = v_last.payment_mode,
    payment_reference = v_last.payment_reference,
    payment_date      = v_last.payment_date,
    -- A cheque signature belongs to the cheque payment it signed; once no cheque
    -- payment stands, the signature is void too.
    cheque_signed_at  = CASE WHEN v_last.payment_mode = 'cheque' THEN v_bill.cheque_signed_at ELSE NULL END,
    cheque_signed_by  = CASE WHEN v_last.payment_mode = 'cheque' THEN v_bill.cheque_signed_by ELSE NULL END
  WHERE id = v_bill.id;

  RETURN jsonb_build_object(
    'bill_id', v_bill.id,
    'amount_reversed', v_pay.amount,
    'amount_paid', v_new_paid,
    'payment_status', v_status,
    'petty_cash_credited', v_pc_credit,
    'tds_reversed', v_tds_total,
    'previous', jsonb_build_object(
      'amount_paid', v_bill.amount_paid,
      'payment_status', v_bill.payment_status
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION reverse_vendor_bill_payment(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reverse_vendor_bill_payment(UUID, UUID, TEXT) TO service_role;

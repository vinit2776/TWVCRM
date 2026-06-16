-- 00261_advance_through_finance_backfill.sql
--
-- PO advances now flow through Finance > Acc Payables, where Accounts records
-- the actual UTR via the existing Record-Payment dialog. The schema already
-- has the columns we need (added in 00056_po_advance_payment.sql:
-- advance_processed_by, advance_processed_at, advance_payment_reference,
-- advance_payment_mode). This migration is purely a backfill to undo a
-- previous "process_advance" click that bypassed Finance and left the
-- downstream bill in an inconsistent state.
--
-- Target: PO-2606-086 was marked advance_status='processed' without a UTR,
-- the bill BILL-2606-069 was auto-pre-credited ₹49,000 on creation, and
-- Finance never actually processed the payment. Reset both so Finance can
-- re-process through the new flow.

DO $$
DECLARE
  v_po_id   UUID;
  v_bill_id UUID;
  v_advance NUMERIC;
BEGIN
  SELECT id, advance_amount INTO v_po_id, v_advance
  FROM purchase_orders WHERE po_number = 'PO-2606-086';

  IF v_po_id IS NULL THEN
    RAISE NOTICE 'PO-2606-086 not found — skipping backfill (safe in non-prod environments)';
    RETURN;
  END IF;

  -- Reset PO advance back to pending so Finance picks it up.
  UPDATE purchase_orders
  SET advance_status              = 'pending',
      advance_processed_by        = NULL,
      advance_processed_at        = NULL,
      advance_payment_date        = NULL,
      advance_payment_mode        = NULL,
      advance_payment_reference   = NULL
  WHERE id = v_po_id;

  -- Unwind the pre-credit on the linked bill. Only safe to do because
  -- BILL-2606-069 has no vendor_bill_payments rows — amount_paid came
  -- entirely from the advance pre-credit. Guarded so the migration is
  -- idempotent and never deducts more than the advance amount.
  SELECT id INTO v_bill_id FROM vendor_bills WHERE bill_number = 'BILL-2606-069';

  IF v_bill_id IS NOT NULL THEN
    UPDATE vendor_bills
    SET amount_paid    = GREATEST(0, amount_paid - v_advance),
        payment_status = (CASE
          WHEN GREATEST(0, amount_paid - v_advance) <= 0 THEN 'unpaid'
          ELSE 'partially_paid'
        END)::bill_payment_status
    WHERE id = v_bill_id
      -- guard: only reset if there are no actual recorded payments
      AND NOT EXISTS (
        SELECT 1 FROM vendor_bill_payments WHERE bill_id = v_bill_id
      );
  END IF;
END $$;

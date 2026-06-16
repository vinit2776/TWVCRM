-- 00259_vendor_bill_partial_clarity.sql
--
-- Make partial approvals and partial payments self-explanatory.
--
-- Background: BILL-2606-069 went out as a partial payment but the system
-- couldn't tell anyone WHY — `approved_amount_note` was optional and
-- `vendor_bill_payments` had no place to record why a partial amount
-- was paid against an approved ceiling.
--
-- Adds two categorical reason columns. The application enforces "required
-- when partial" so historical rows stay valid (NULL allowed at the DB level).

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS approved_amount_reason TEXT;

COMMENT ON COLUMN vendor_bills.approved_amount_reason IS
  'Categorical reason for partial approval (e.g. pending_delivery, qc_hold, invoice_discrepancy, retention, other). Free-text detail lives in approved_amount_note. Required by app layer when approved_amount < total_amount.';

ALTER TABLE vendor_bill_payments
  ADD COLUMN IF NOT EXISTS partial_reason TEXT;

COMMENT ON COLUMN vendor_bill_payments.partial_reason IS
  'Categorical reason a payment was recorded for less than the approved outstanding amount (e.g. cashflow_hold, retention, dispute_pending, awaiting_docs, other). Free-text detail lives in notes. Required by app layer when amount < approved_outstanding.';

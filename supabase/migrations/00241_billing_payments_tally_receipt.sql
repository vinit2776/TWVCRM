-- Tally receipt-voucher reverse-sync mirror columns on billing_payments.
--
-- When a payment is recorded against a Tally-issued GST invoice, the CRM enqueues
-- a receipt_voucher job; the bridge posts a Receipt voucher in Tally and acks back
-- the receipt voucher number + GUID. These columns mirror that back onto the
-- payment row so the CRM shows "synced to Tally" and reconciliation can match
-- CRM payments to Tally receipts.
--
-- NULL = not synced to Tally (CRM-issued invoice, or sync was off, or pending).

ALTER TABLE billing_payments
  ADD COLUMN IF NOT EXISTS tally_receipt_number       TEXT,
  ADD COLUMN IF NOT EXISTS tally_receipt_voucher_guid TEXT,
  ADD COLUMN IF NOT EXISTS tally_receipt_synced_at    TIMESTAMPTZ;

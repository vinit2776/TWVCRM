-- Add batch_ref to vendor_bill_payments so multiple payment rows
-- created in a single "pay selected" action share one UUID.
-- The UUID is generated client-side and passed to the batch-payment API.

ALTER TABLE vendor_bill_payments
  ADD COLUMN IF NOT EXISTS batch_ref UUID;

CREATE INDEX IF NOT EXISTS idx_vendor_bill_payments_batch_ref
  ON vendor_bill_payments (batch_ref)
  WHERE batch_ref IS NOT NULL;

-- Migration: add billing_mode to contracts
-- Controls whether the monthly cycle issues a Proforma Invoice first (default)
-- or a GST tax invoice directly.
--
-- proforma_first (default): PI → customer pays → GST invoice issued
-- gst_direct:               GST invoice issued directly; due_date = issue_date + 7 days

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'proforma_first'
  CONSTRAINT contracts_billing_mode_check
    CHECK (billing_mode IN ('proforma_first', 'gst_direct'));

-- All existing contracts default to proforma_first (the current live behaviour).
-- No data backfill needed.

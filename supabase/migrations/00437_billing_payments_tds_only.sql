-- Allow a TDS-only payment entry: a customer certifies TDS on a balance
-- separately from an earlier cash payment (e.g. cash recorded first, TDS
-- certificate arrives weeks later). Previously amount > 0 was mandatory,
-- which made it impossible to record a zero-cash, TDS-only settlement to
-- close the remaining balance.
ALTER TABLE billing_payments
  DROP CONSTRAINT IF EXISTS billing_payments_amount_check;

ALTER TABLE billing_payments
  ADD CONSTRAINT billing_payments_amount_check
    CHECK (amount >= 0 AND (amount > 0 OR tds_amount > 0));

COMMENT ON COLUMN billing_payments.amount IS
  'Cash/bank amount received. Can be 0 only when tds_amount > 0 (a TDS-only settlement entry) — see payment_mode = ''tds_deduction'' for these rows.';

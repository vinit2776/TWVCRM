-- Actor/reason columns for the draft discard flow, mirroring the void columns
-- added in 00155 (voided_at / voided_by / void_reason).
--
-- Discarding is reason-mandatory and audited: a discarded draft un-links its
-- usage charges, bookings and service-usage records back to re-billable, so
-- "who threw this away and why" has to be answerable from the row itself.

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS discarded_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS discarded_by     UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS discard_reason   TEXT;

-- The billing generators' "already has a statement for this period" checks
-- filter on status, so a partial index on the live states keeps those lookups
-- off the discarded/voided rows they now ignore.
CREATE INDEX IF NOT EXISTS idx_billing_statements_active_period
  ON billing_statements (contract_id, period_start)
  WHERE status NOT IN ('voided', 'discarded');

-- Proforma-First vs GST-Direct choice for direct-client cases — mirrors
-- aggregators.billing_mode (00403). Aggregator-sourced cases ignore this
-- column entirely and keep using their aggregator's own billing_mode;
-- this only matters when case_source = 'direct' (no aggregator exists to
-- hold a mode). Defaults to proforma_first — direct/walk-in clients need to
-- be able to pay immediately via a Razorpay link, not wait on an accountant
-- to manually issue a Tally GST invoice first.

ALTER TABLE cases
  ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'proforma_first'
  CONSTRAINT cases_billing_mode_check CHECK (billing_mode IN ('proforma_first', 'gst_direct'));

COMMENT ON COLUMN cases.billing_mode IS 'Only meaningful for case_source = ''direct'' — aggregator-sourced cases use their aggregator''s billing_mode instead.';

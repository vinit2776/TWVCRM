-- Per-aggregator choice of Proforma-First vs GST-Direct billing, mirroring
-- contracts.billing_mode (00230_contract_billing_mode.sql) so aggregator
-- invoicing (prepaid per-case and postpaid consolidated) can route through
-- the same dispatchProforma()/dispatchGstDirect()-style pipeline contracts
-- already use, instead of VO being GST-direct-only.
--
-- Default 'gst_direct' (not 'proforma_first' like contracts) — matches the
-- behavior already built for Virtual Office billing; existing aggregators
-- keep today's behavior unless someone explicitly opts into proforma_first.

ALTER TABLE aggregators
  ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'gst_direct'
  CONSTRAINT aggregators_billing_mode_check CHECK (billing_mode IN ('proforma_first', 'gst_direct'));

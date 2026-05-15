-- Track which user performed each billing statement lifecycle transition
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS finalized_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proforma_sent_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gst_generated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accounted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accounted_at      TIMESTAMPTZ;

COMMENT ON COLUMN billing_statements.finalized_by     IS 'User who finalized this draft statement';
COMMENT ON COLUMN billing_statements.proforma_sent_by IS 'User who sent the proforma invoice';
COMMENT ON COLUMN billing_statements.gst_generated_by IS 'User who generated and sent the GST tax invoice';
COMMENT ON COLUMN billing_statements.accounted_by     IS 'User who marked this statement as accounted';
COMMENT ON COLUMN billing_statements.accounted_at     IS 'Timestamp when statement was marked accounted';

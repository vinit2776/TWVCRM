-- Lets accounts recategorize an ad-hoc-invoice-sourced billing_statement that
-- was mis-tagged as taxable revenue but actually collected a security deposit,
-- closing it out of the Tally Inbox GST worklist without a Tally GST invoice.
-- See src/app/api/billing-statements/[id]/waive-gst/route.ts.
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS gst_waived_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gst_waived_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS gst_waived_reason TEXT,
  ADD COLUMN IF NOT EXISTS gst_waived_deposit_topup_id UUID REFERENCES deposit_topups(id);

CREATE INDEX IF NOT EXISTS idx_billing_statements_gst_waived_at ON billing_statements(gst_waived_at);

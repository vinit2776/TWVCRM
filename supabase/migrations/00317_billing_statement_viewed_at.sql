-- Track when clients view their emailed invoices (click-through redirect pattern).
--
-- proforma_viewed_at   — set when a proforma_first client clicks "View Invoice"
--                        in the proforma email (redirects via /api/billing-statements/[id]/track?type=proforma)
--
-- gst_invoice_viewed_at — set when a gst_direct client clicks "View Invoice"
--                         in the GST invoice email (redirects via /api/billing-statements/[id]/track?type=gst)
--
-- Both are idempotent: the tracking route only sets them once (WHERE col IS NULL).

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS proforma_viewed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS gst_invoice_viewed_at timestamptz;

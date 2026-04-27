-- Razorpay payment link + GST invoice tracking on adhoc proforma invoices
ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS razorpay_link_id         TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_link_url         TEXT,
  ADD COLUMN IF NOT EXISTS gst_invoice_number        TEXT,
  ADD COLUMN IF NOT EXISTS gst_invoice_sent_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gst_invoice_sent_to       TEXT;

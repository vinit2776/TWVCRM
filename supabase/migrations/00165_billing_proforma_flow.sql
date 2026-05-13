-- Proforma invoice flow: track when proforma was sent to customer
-- GST invoice is now only generated after payment is confirmed, not upfront.
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS proforma_sent_at timestamptz;

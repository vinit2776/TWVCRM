-- Auto-billing: add GST invoice and payment link fields to billing_statements

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS razorpay_payment_link_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_payment_link_url TEXT,
  ADD COLUMN IF NOT EXISTS gst_invoice_path TEXT,
  ADD COLUMN IF NOT EXISTS gst_invoice_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS cgst_amount DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_amount DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_amount DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_interstate BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS hsn_sac_code VARCHAR(20) DEFAULT '997212',
  ADD COLUMN IF NOT EXISTS buyer_gstin VARCHAR(20),
  ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(50) DEFAULT 'Tamil Nadu',
  ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS emailed_to TEXT;

-- Auto-incrementing GST invoice number
CREATE SEQUENCE IF NOT EXISTS gst_invoice_seq START 1;

-- Helper function to get next invoice sequence number via Supabase RPC
CREATE OR REPLACE FUNCTION next_gst_invoice_number()
RETURNS bigint LANGUAGE sql AS $$
  SELECT nextval('gst_invoice_seq');
$$;

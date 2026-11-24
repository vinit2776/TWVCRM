-- NOC service, part 2 (customer link, acceptance, payment): what turns a draft order into something the
-- customer can read, accept and pay. Builds on 00754. Plan: docs/plans/noc-service.md.
--
-- noc_requests gains: the unguessable public link token, the invoice and statement the fee is billed on,
-- who it was sent to, the customer's acceptance (typed name and designation, hash of the exact words,
-- IP and device), the acceptance certificate, the gateway link, and the payment.
-- noc_otp_codes holds the one-time codes that prove the person is the contact on the contract. Codes are
-- stored hashed and no signed-in user can read the table (a deny-all policy; only the server reads it).
--
-- Rollback (nothing else depends on these):
--   DROP TABLE IF EXISTS noc_otp_codes;
--   ALTER TABLE noc_requests
--     DROP COLUMN IF EXISTS public_token, DROP COLUMN IF EXISTS gstin, DROP COLUMN IF EXISTS invoice_id,
--     DROP COLUMN IF EXISTS billing_statement_id, DROP COLUMN IF EXISTS sent_at, DROP COLUMN IF EXISTS sent_to,
--     DROP COLUMN IF EXISTS accepted_at, DROP COLUMN IF EXISTS accepted_by_name,
--     DROP COLUMN IF EXISTS accepted_by_designation, DROP COLUMN IF EXISTS accepted_text_hash,
--     DROP COLUMN IF EXISTS accepted_ip, DROP COLUMN IF EXISTS accepted_user_agent,
--     DROP COLUMN IF EXISTS acceptance_document_id, DROP COLUMN IF EXISTS razorpay_link_id,
--     DROP COLUMN IF EXISTS razorpay_link_url, DROP COLUMN IF EXISTS paid_at, DROP COLUMN IF EXISTS payment_reference;

ALTER TABLE noc_requests
  ADD COLUMN IF NOT EXISTS public_token TEXT NOT NULL
    DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  ADD COLUMN IF NOT EXISTS gstin TEXT,                       -- the company's GSTIN, for the GST invoice buyer
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES proforma_invoices(id),
  ADD COLUMN IF NOT EXISTS billing_statement_id UUID REFERENCES billing_statements(id),
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_to TEXT,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_by_name TEXT,
  ADD COLUMN IF NOT EXISTS accepted_by_designation TEXT,
  ADD COLUMN IF NOT EXISTS accepted_text_hash TEXT,
  ADD COLUMN IF NOT EXISTS accepted_ip TEXT,
  ADD COLUMN IF NOT EXISTS accepted_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS acceptance_document_id UUID REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS razorpay_link_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_link_url TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_reference TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS noc_requests_public_token_key ON noc_requests (public_token);
CREATE INDEX IF NOT EXISTS noc_requests_invoice_idx ON noc_requests (invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS noc_otp_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  noc_id UUID NOT NULL REFERENCES noc_requests(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  sent_to TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS noc_otp_codes_noc_idx ON noc_otp_codes (noc_id, created_at DESC);

ALTER TABLE noc_otp_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "noc_otp_codes_deny" ON noc_otp_codes;
CREATE POLICY "noc_otp_codes_deny" ON noc_otp_codes FOR SELECT TO authenticated USING (false);

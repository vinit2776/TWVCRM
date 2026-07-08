-- Allow billing statements to be linked to an ad-hoc lead invoice (proforma_invoices),
-- alongside the existing contract_id / booking_id / proposal_id owners. This lets
-- ad-hoc invoices flow through the same Accounts Receivable follow-up ladder and
-- Tally Inbox GST-handoff pipeline every other invoice type in the system uses,
-- and removes the CRM's self-generated pseudo "GST Tax Invoice" email on payment
-- (no real IRN, never issued via Tally) in favor of the real Tally-backed GST invoice.

-- 1. Add invoice_id FK
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES proforma_invoices(id) ON DELETE CASCADE;

-- 2. Widen the source-ownership CHECK to also allow invoice_id as an owner.
ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_source_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_source_check
  CHECK (contract_id IS NOT NULL OR booking_id IS NOT NULL OR proposal_id IS NOT NULL OR invoice_id IS NOT NULL);

-- 3. Index for quick lookup by invoice
CREATE INDEX IF NOT EXISTS idx_billing_statements_invoice_id
  ON billing_statements(invoice_id)
  WHERE invoice_id IS NOT NULL;

-- 4. Widen created_via CHECK to add an origin value for this flow.
ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_created_via_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_created_via_check
  CHECK (created_via IS NULL OR created_via IN (
    'cron',
    'ad_hoc_request',
    'manual_correction',
    'legacy',
    'proposal_pi',
    'adhoc_invoice'      -- ad-hoc lead invoice (proforma_invoices), sent via /api/invoices/[id]/email
  ));

COMMENT ON COLUMN billing_statements.invoice_id IS
  'Set for statements originating from an ad-hoc lead invoice (proforma_invoices) '
  'sent via /api/invoices/[id]/email. NULL for ordinary contract/booking/proposal statements.';

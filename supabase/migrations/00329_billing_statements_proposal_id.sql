-- Allow billing statements to be linked to a proposal (not just a contract or booking).
-- This lets the proposal's first-month pro-rata proforma invoice (PI) become a real
-- billing_statements row, so it flows through the same Accounts Receivable follow-up
-- ladder and Tally Inbox GST-handoff pipeline every contract invoice already uses.

-- 1. Add proposal_id FK
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS proposal_id UUID REFERENCES proposals(id) ON DELETE CASCADE;

-- 2. Widen the source-ownership CHECK (introduced in 00041 for booking_id) to also
--    allow proposal_id as an owner.
ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_source_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_source_check
  CHECK (contract_id IS NOT NULL OR booking_id IS NOT NULL OR proposal_id IS NOT NULL);

-- 3. Index for quick lookup by proposal
CREATE INDEX IF NOT EXISTS idx_billing_statements_proposal_id
  ON billing_statements(proposal_id)
  WHERE proposal_id IS NOT NULL;

-- 4. Widen created_via CHECK (00255) to add an origin value for this flow.
ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_created_via_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_created_via_check
  CHECK (created_via IS NULL OR created_via IN (
    'cron',
    'ad_hoc_request',
    'manual_correction',
    'legacy',
    'proposal_pi'        -- proposal-stage pro-rata PI (send-invoice route, or backfill)
  ));

COMMENT ON COLUMN billing_statements.proposal_id IS
  'Set for statements originating from a proposal''s first-month pro-rata PI '
  '(no contract exists yet). NULL for ordinary contract/booking statements.';

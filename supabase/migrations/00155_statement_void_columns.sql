-- Fix 20: Statement void & re-issue
--
-- Adds columns to billing_statements for void tracking and
-- linking voided originals to their replacement drafts.

-- Void metadata on the original statement
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by     UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS void_reason   TEXT;

-- Back-reference on the replacement draft → voided original
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS voided_statement_id UUID REFERENCES billing_statements(id);

-- Allow 'voided' as a status value (no enum constraint — status is TEXT)
-- Add an index for quick lookups of voided statements
CREATE INDEX IF NOT EXISTS idx_billing_statements_voided
  ON billing_statements (voided_statement_id)
  WHERE voided_statement_id IS NOT NULL;

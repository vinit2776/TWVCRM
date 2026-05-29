-- Auto-proforma split: distinguish rent proformas (auto-dispatched) from
-- usage statements (admin review queue) from legacy combined statements.
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS statement_type TEXT DEFAULT 'combined'
    CHECK (statement_type IN ('combined', 'rent', 'usage'));

-- Backfill: all existing statements are the legacy combined type
UPDATE billing_statements
SET statement_type = 'combined'
WHERE statement_type IS NULL;

-- Index for per-type idempotency queries in the new generators
CREATE INDEX IF NOT EXISTS billing_statements_type_period_idx
  ON billing_statements (contract_id, statement_type, period_start);

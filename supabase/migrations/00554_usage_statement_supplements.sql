-- Migration: 00554_usage_statement_supplements
--
-- Problem: once a usage statement for a contract+month is finalized/sent,
-- there was no way to bill an item that surfaces afterward for that same
-- month (e.g. conference room usage was billed on time, but the printer
-- meter reading came in a week later). generateUsageStatements() skipped
-- the whole contract outright once a covering statement existed, and
-- POST /api/usage-charges additionally hard-blocked logging a new ad-hoc
-- charge for that period. The only "fix" was voiding the original, which
-- is itself blocked once it's been paid — so a paid month with a missed
-- item had no path forward at all.
--
-- This adds a supplemental-statement concept: a second, later usage
-- statement for the same contract+period that covers only what the first
-- one missed, cross-referenced back to it. The original is never reopened
-- or edited.
ALTER TABLE billing_statements
  ADD COLUMN supplements_statement_id UUID REFERENCES billing_statements(id) ON DELETE SET NULL;

COMMENT ON COLUMN billing_statements.supplements_statement_id IS
  'Set only on a supplemental usage statement — points to the original (already sent/paid) statement it tops up. NULL for every ordinary statement, including the original itself.';

CREATE INDEX idx_billing_statements_supplements ON billing_statements(supplements_statement_id) WHERE supplements_statement_id IS NOT NULL;

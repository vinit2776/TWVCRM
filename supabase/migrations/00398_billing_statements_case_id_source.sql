-- Fix a live bug: createRenewalBillingStatement() (src/lib/vo-renewal.ts) inserts
-- billing_statements rows with only case_id set (no contract_id/booking_id/
-- proposal_id/invoice_id). case_id was added as a column in 00308_vo_renewal.sql
-- but was never added to billing_statements_source_check, so every such insert
-- has been violating this CHECK constraint. A sibling bug on the same insert
-- (statement_type rejecting 'vo_renewal') was already found and fixed once in
-- 00382_vo_renewal_cron_fixes.sql — this is the second, still-unfixed violation
-- on the same code path.

ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_source_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_source_check
  CHECK (
    contract_id IS NOT NULL OR booking_id IS NOT NULL OR proposal_id IS NOT NULL
    OR invoice_id IS NOT NULL OR case_id IS NOT NULL
  );

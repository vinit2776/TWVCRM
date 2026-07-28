-- Fix two more gaps in the automated VO renewal cron (src/lib/vo-renewal.ts,
-- src/app/api/cron/vo-renewal/route.ts) that would otherwise fail once a case
-- reaches its renewal window:

-- 1. The cron writes cases.renewal_last_reminder_at, but that column never existed.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS renewal_last_reminder_at timestamptz;

-- 2. createRenewalBillingStatement() inserts statement_type = 'vo_renewal', which
--    the CHECK constraint rejected — this was the first failure point in the whole
--    renewal-opening branch.
ALTER TABLE billing_statements DROP CONSTRAINT IF EXISTS billing_statements_statement_type_check;
ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_statement_type_check
  CHECK (statement_type IN ('combined', 'rent', 'usage', 'electricity', 'reimbursement', 'vo_renewal'));

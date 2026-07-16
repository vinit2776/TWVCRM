-- ============================================================
-- Migration 00349: Reimbursement department
--
-- Introduces a "reimbursement" procurement department: spend
-- incurred on behalf of a customer (maintenance, furniture,
-- housekeeping, etc.) that sits outside normal department budgets
-- and is recovered from the customer via a manually marked-up
-- billing_statements invoice, rather than the monthly usage rollup.
--
-- 1. Add 'reimbursement' to procurement_department enum (same
--    pattern as 'asset'/'amc' in migrations 00070/00250).
-- 2. purchase_requests.billable_contract_id — which customer this
--    reimbursement job will be billed to. Required at the app layer
--    when department = 'reimbursement'; nullable in the DB since
--    every other department leaves it unset.
-- 3. billing_statements.source_pr_id — traces a reimbursement
--    invoice back to the purchase_request it was billed from. A PR
--    can have multiple statements over time (e.g. an upfront advance
--    followed by a balance invoice once the job is done).
-- 4. Widen billing_statements.statement_type CHECK to add
--    'reimbursement' to the existing ('combined', 'rent', 'usage',
--    'electricity') set. (The docs/modules/billing.md note about
--    'electricity' missing from this CHECK is stale — verified
--    against the live constraint definition, it's already present.)
-- ============================================================

ALTER TYPE procurement_department ADD VALUE IF NOT EXISTS 'reimbursement';

-- Which customer this reimbursement job will be billed to. Required
-- at the app layer when department = 'reimbursement'.
ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS billable_contract_id UUID REFERENCES contracts(id);

CREATE INDEX IF NOT EXISTS idx_purchase_requests_billable_contract
  ON purchase_requests(billable_contract_id)
  WHERE billable_contract_id IS NOT NULL;

-- Traces a reimbursement invoice back to the purchase_request it was
-- billed from. One PR can have multiple statements over time.
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS source_pr_id UUID REFERENCES purchase_requests(id);

CREATE INDEX IF NOT EXISTS idx_billing_statements_source_pr
  ON billing_statements(source_pr_id)
  WHERE source_pr_id IS NOT NULL;

-- Widen statement_type to add 'reimbursement' to the existing set.
ALTER TABLE billing_statements DROP CONSTRAINT IF EXISTS billing_statements_statement_type_check;
ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_statement_type_check
  CHECK (statement_type IN ('combined', 'rent', 'usage', 'electricity', 'reimbursement'));

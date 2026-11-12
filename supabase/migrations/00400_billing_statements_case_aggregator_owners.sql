-- Add aggregator_id as a billing_statements owner, for postpaid Virtual Office
-- consolidated invoices (many cases, one aggregator — doesn't fit a single
-- case_id). Per-case statements (prepaid aggregator / direct client) keep
-- using the existing case_id column.
--
-- Widens the source-ownership CHECK, created_via, and statement_type CHECKs
-- (latest prior definitions: 00330 for source_check/created_via, 00382 for
-- statement_type) to accommodate the new VO invoice paths.

ALTER TABLE billing_statements
  ADD COLUMN aggregator_id UUID REFERENCES aggregators(id) ON DELETE RESTRICT;

CREATE INDEX idx_billing_statements_aggregator_id
  ON billing_statements(aggregator_id)
  WHERE aggregator_id IS NOT NULL;

ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_source_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_source_check
  CHECK (
    contract_id IS NOT NULL OR booking_id IS NOT NULL OR proposal_id IS NOT NULL
    OR invoice_id IS NOT NULL OR case_id IS NOT NULL OR aggregator_id IS NOT NULL
  );

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
    'adhoc_invoice',
    'vo_case_request',       -- per-case VO invoice (prepaid aggregator or direct client)
    'vo_aggregator_monthly'  -- postpaid aggregator consolidated invoice
  ));

ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_statement_type_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_statement_type_check
  CHECK (statement_type IN (
    'combined', 'rent', 'usage', 'electricity', 'reimbursement', 'vo_renewal',
    'vo_case',                  -- per-case VO invoice
    'vo_aggregator_consolidated' -- postpaid aggregator consolidated invoice
  ));

COMMENT ON COLUMN billing_statements.aggregator_id IS 'Set only for vo_aggregator_consolidated statements (postpaid, many cases bundled).';

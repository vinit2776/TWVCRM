-- Allow more than one usage invoice per contract per month.
--
-- Contract/month grouped usage billing (src/lib/usage-billing.ts) sends a late
-- charge for an already-invoiced month as its own invoice for that month — an
-- agreed rule that replaces the old "one original + one automatic supplement"
-- model. idx_bs_contract_period_type_unique (00254 → 00432 → 00555) allows only
-- one live original per (contract_id, period_start, statement_type), which
-- blocks that.
--
-- Scope of the change: statement_type = 'usage' only. Rent, combined,
-- electricity and every other type keep exactly the constraint 00555 left.
-- For usage, double billing is prevented at the charge level instead: each
-- charge can be linked to only one statement, enforced with row locks inside
-- create_usage_invoice (00564).
--
-- idx_bs_one_live_supplement_per_original is untouched (only the old
-- generator creates supplements).
--
-- Rollback (only while no contract-month has two live usage originals):
--   DROP INDEX IF EXISTS idx_bs_contract_period_type_unique;
--   CREATE UNIQUE INDEX idx_bs_contract_period_type_unique
--     ON billing_statements (contract_id, period_start, statement_type)
--     WHERE status NOT IN ('voided', 'discarded') AND supplements_statement_id IS NULL;

DROP INDEX IF EXISTS idx_bs_contract_period_type_unique;

CREATE UNIQUE INDEX idx_bs_contract_period_type_unique
  ON billing_statements (contract_id, period_start, statement_type)
  WHERE status NOT IN ('voided', 'discarded')
    AND supplements_statement_id IS NULL
    AND statement_type <> 'usage';

-- Discarded statements must release the unique slot, exactly as voided ones do.
--
-- Two partial unique indexes guard against duplicate active statements:
--   idx_bs_contract_period_type_unique  (contract_id, period_start, statement_type)   -- 00254
--   uq_statement_contract_period_type   (contract_id, prepaid_year, prepaid_month, …) -- 00316
-- Both were written as `WHERE status != 'voided'`, which was complete at the
-- time. 00428 added a second terminal state, and a discarded row keeps
-- status = 'discarded' with voided_at NULL — so it still occupies the slot.
--
-- Effect before this fix: discard released the application-level guards (the
-- generators, the manual-create dup check) but the INSERT still failed with
-- "duplicate key value violates unique constraint idx_bs_contract_period_type_unique",
-- so the period could not actually be regenerated. Caught in production
-- testing on the void → discard-the-replacement → regenerate path.
--
-- Rollback: recreate both indexes with `WHERE status != 'voided'`.

DROP INDEX IF EXISTS idx_bs_contract_period_type_unique;

CREATE UNIQUE INDEX idx_bs_contract_period_type_unique
  ON billing_statements (contract_id, period_start, statement_type)
  WHERE status NOT IN ('voided', 'discarded');

DROP INDEX IF EXISTS uq_statement_contract_period_type;

CREATE UNIQUE INDEX uq_statement_contract_period_type
  ON billing_statements (contract_id, prepaid_year, prepaid_month, statement_type)
  WHERE status NOT IN ('voided', 'discarded');

-- 00429's idx_billing_statements_active_period is now redundant: the unique
-- index above leads on the same (contract_id, period_start) columns with the
-- same predicate, so it can serve those lookups on its own.
DROP INDEX IF EXISTS idx_billing_statements_active_period;

-- Fix: unique constraint on billing_statements must exclude voided rows.
--
-- The original constraint (added in 00315) has no WHERE clause, so voided
-- statements permanently occupy the unique slot (contract_id, prepaid_year,
-- prepaid_month, statement_type). When the billing batch voids a statement
-- and tries to insert a replacement, the INSERT fails with a duplicate key
-- violation because the voided row still holds the slot.
--
-- This is especially visible for GST Direct contracts (proforma_sent_at is
-- always null → batch treats them as "unsent" on every re-run and tries to
-- void+replace) and for any PI First contract where the dispatch failed.

ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS uq_statement_contract_period_type;

CREATE UNIQUE INDEX uq_statement_contract_period_type
  ON billing_statements (contract_id, prepaid_year, prepaid_month, statement_type)
  WHERE (status != 'voided');

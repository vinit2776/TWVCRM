-- Migration: 00555_usage_statement_supplements_unique_fix
--
-- idx_bs_contract_period_type_unique (00254, tightened in 00432) allows at
-- most one non-voided/non-discarded statement per (contract_id, period_start,
-- statement_type). That's exactly what blocked the first real supplemental
-- usage statement insert: "duplicate key value violates unique constraint
-- idx_bs_contract_period_type_unique" — a supplement necessarily shares its
-- contract, period_start, and statement_type with the original it tops up.
--
-- Fix: scope that constraint to ORIGINALS only (supplements_statement_id IS
-- NULL) — a contract+period+type still gets at most one original, exactly as
-- before. A second unique index guards supplements instead: at most one live
-- supplement per original. This is the DB-level backstop for the "one
-- automatic supplement per original" rule generateUsageStatements already
-- enforces in application code (src/lib/billing.ts) — not a relaxation of it.
--
-- Rollback: drop both indexes below and recreate the original
-- idx_bs_contract_period_type_unique exactly as 00432 left it (no
-- supplements_statement_id predicate) — but only after removing any
-- supplemental statement rows, since they'd violate that stricter index.

DROP INDEX IF EXISTS idx_bs_contract_period_type_unique;

CREATE UNIQUE INDEX idx_bs_contract_period_type_unique
  ON billing_statements (contract_id, period_start, statement_type)
  WHERE status NOT IN ('voided', 'discarded') AND supplements_statement_id IS NULL;

CREATE UNIQUE INDEX idx_bs_one_live_supplement_per_original
  ON billing_statements (supplements_statement_id)
  WHERE status NOT IN ('voided', 'discarded') AND supplements_statement_id IS NOT NULL;

-- ============================================================
-- 00120: Retire the unused contracts.printer_department_id column
--
-- 00075 added contracts.printer_department_id with a globally-unique
-- (across all active contracts) constraint. The column was never
-- populated (0 rows). 00119 introduced contracts.department_id with
-- the per-location unique constraint we actually want, so the older
-- column is dead weight. Drop both the column and its index.
-- ============================================================

DROP INDEX IF EXISTS idx_contracts_dept_id_active;

ALTER TABLE contracts
  DROP COLUMN IF EXISTS printer_department_id;

-- ============================================================
-- 00122: Department ID — back to per-location uniqueness
--
-- 00121 made department_id globally unique based on a misread of the
-- requirement. The actual rule: same ID can exist at different
-- locations (e.g. "Loc A — 1" and "Loc B — 1" are both valid because
-- they're different printers/networks). This migration:
--   1. Drops uniq_contracts_dept_id (the global one from 00121)
--   2. Restores uniq_contracts_dept_per_loc (the per-location one)
--   3. Clears any department_id where location_id IS NULL — by the
--      new product rule, contracts without a location can't have a
--      department ID at all (no printer to map to).
-- ============================================================

DROP INDEX IF EXISTS uniq_contracts_dept_id;

-- Clear department_id on any contract that lacks a location.
-- These rows shouldn't have had an ID in the first place under the
-- new rule. Unsetting them prevents data drift.
UPDATE contracts
   SET department_id = NULL
 WHERE location_id IS NULL
   AND department_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_contracts_dept_per_loc
  ON contracts(location_id, department_id)
  WHERE department_id IS NOT NULL;

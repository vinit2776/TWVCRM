-- ============================================================
-- 00121: Department IDs must be globally unique (not per location)
--
-- 00119 made contracts.department_id unique-per-location, but the
-- printer-server reality is that a single ID like "1" or "110" should
-- never appear at two different locations — operations have asked to
-- enforce global uniqueness so the same physical printer card / login
-- can't be reassigned to two customers across the network.
--
-- Replace the partial (location_id, department_id) unique index with a
-- partial unique index on department_id alone. NULLs still allowed
-- (multiple un-assigned contracts is fine).
-- ============================================================

DROP INDEX IF EXISTS uniq_contracts_dept_per_loc;

-- Pre-clean: any duplicate department_id values across contracts
-- get the older row's value cleared. The bulk-assign page lets the
-- admin reassign a different ID afterwards. We keep the most recently
-- updated row's value as the canonical one.
WITH ranked AS (
  SELECT id,
         department_id,
         ROW_NUMBER() OVER (
           PARTITION BY department_id
           ORDER BY updated_at DESC, created_at DESC
         ) AS rn
    FROM contracts
   WHERE department_id IS NOT NULL
)
UPDATE contracts
   SET department_id = NULL
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_contracts_dept_id
  ON contracts(department_id)
  WHERE department_id IS NOT NULL;

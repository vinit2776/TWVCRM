-- ============================================================
-- Migration 00099: Fix department_budgets unique constraint for NULL location_id
--
-- Root cause: UNIQUE (department, location_id) uses PostgreSQL's standard
-- behaviour where NULL != NULL in unique index comparisons. This allowed
-- repeated upserts with location_id = NULL to INSERT new rows instead of
-- updating existing ones, silently ignoring the conflict.
--
-- Fix:
--   1. De-duplicate any phantom rows created by the broken upsert
--      (keep the oldest row per department where location_id IS NULL)
--   2. Drop the original composite unique constraint
--   3. Add a partial unique index WHERE location_id IS NULL — this enforces
--      uniqueness correctly for the global-budget rows without breaking
--      location-scoped rows (where location_id IS NOT NULL and the old
--      constraint still applies via the original table UNIQUE).
-- ============================================================

-- Step 1: Remove duplicate rows, keeping the oldest one per department
DELETE FROM department_budgets
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY department
        ORDER BY created_at ASC
      ) AS rn
    FROM department_budgets
    WHERE location_id IS NULL
  ) ranked
  WHERE rn > 1
);

-- Step 2: Drop the original composite unique constraint (covers all rows)
ALTER TABLE department_budgets
  DROP CONSTRAINT IF EXISTS department_budgets_department_location_id_key;

-- Step 3: Add partial unique index for global rows (location_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS department_budgets_dept_global_unique
  ON department_budgets (department)
  WHERE location_id IS NULL;

-- Step 4: Re-add composite unique constraint only for location-scoped rows
CREATE UNIQUE INDEX IF NOT EXISTS department_budgets_dept_location_unique
  ON department_budgets (department, location_id)
  WHERE location_id IS NOT NULL;

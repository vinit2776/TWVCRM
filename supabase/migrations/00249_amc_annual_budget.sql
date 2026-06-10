-- ============================================================
-- Migration 00249: AMC Annual Budget
--
-- AMC becomes its own top-level budget category, separate from
-- the 4 operational departments (pantry, maintenance, administration, asset).
-- Budget is annual (financial year: April–March) rather than monthly.
--
-- Changes:
--   1. Add budget_period ('monthly'|'annual') and financial_year columns
--      to department_budgets.
--   2. Add a partial unique index for AMC annual budget rows keyed on
--      financial_year (one row per FY, global — location_id IS NULL).
-- ============================================================

-- Step 1: Add budget_period column (default 'monthly' — existing rows unaffected)
ALTER TABLE department_budgets
  ADD COLUMN IF NOT EXISTS budget_period TEXT NOT NULL DEFAULT 'monthly'
    CHECK (budget_period IN ('monthly', 'annual'));

-- Step 2: Add financial_year column (NULL for monthly rows; YYYY for AMC annual rows)
-- financial_year = 2025 means FY 2025-26 (April 2025 – March 2026)
ALTER TABLE department_budgets
  ADD COLUMN IF NOT EXISTS financial_year INTEGER DEFAULT NULL
    CHECK (financial_year IS NULL OR (financial_year >= 2024 AND financial_year <= 2099));

-- Step 3: Partial unique index for AMC annual rows (one per FY, global scope)
CREATE UNIQUE INDEX IF NOT EXISTS department_budgets_amc_annual_fy_unique
  ON department_budgets (financial_year)
  WHERE department = 'amc' AND location_id IS NULL AND budget_period = 'annual';

-- Note: The existing partial index department_budgets_dept_global_unique
-- (ON department_budgets (department) WHERE location_id IS NULL)
-- continues to enforce uniqueness for the 4 monthly department rows.

-- ============================================================
-- Migration 00567: Scope AMC annual budget uniqueness to company_id
--
-- Root cause: 00249_amc_annual_budget.sql created
-- department_budgets_amc_annual_fy_unique keyed on financial_year alone
-- (no company_id) — one AMC annual budget per FY, globally, across every
-- company. Once one company set an AMC budget for a given FY, no other
-- company could set one for the same FY (unique violation).
--
-- 00540_procurement_company_scoping.sql added company_id and rebuilt the
-- *monthly* department-budget uniqueness indexes to include it, but missed
-- this AMC-specific one. It also introduced a second, related bug:
-- department_budgets_company_dept_global_unique is (company_id, department)
-- WHERE location_id IS NULL with no budget_period filter — since AMC annual
-- rows also have location_id IS NULL, that index allows only one AMC row
-- ever per company (any FY), colliding on the second financial year.
--
-- Fix:
--   1. Rebuild department_budgets_amc_annual_fy_unique to include
--      company_id — one AMC annual budget per company per FY.
--   2. Narrow department_budgets_company_dept_global_unique to
--      budget_period = 'monthly' only, so it no longer overlaps with AMC's
--      annual rows (which are governed solely by the FY-scoped index above).
--
-- No data cleanup needed: both changes relax existing constraints (widen
-- the key / narrow the WHERE clause), so no row already satisfying the old
-- indexes can violate the new ones.
-- ============================================================

DROP INDEX IF EXISTS department_budgets_amc_annual_fy_unique;

CREATE UNIQUE INDEX IF NOT EXISTS department_budgets_amc_annual_fy_unique
  ON department_budgets (company_id, financial_year)
  WHERE department = 'amc' AND location_id IS NULL AND budget_period = 'annual';

DROP INDEX IF EXISTS department_budgets_company_dept_global_unique;

CREATE UNIQUE INDEX IF NOT EXISTS department_budgets_company_dept_global_unique
  ON department_budgets (company_id, department)
  WHERE location_id IS NULL AND budget_period = 'monthly';

-- ============================================================
-- Migration 00251: Backfill existing AMC purchase_requests
--
-- Runs after 00250 (which added 'amc' to procurement_department
-- enum). Separate migration required because PostgreSQL cannot
-- reference a newly added enum value in the same transaction.
--
-- Converts the 14 existing MRs that were created as:
--   department='maintenance', expenditure_type='amc'
-- to:
--   department='amc',         expenditure_type='amc'
--
-- This makes them appear correctly in the AMC module and budget
-- tracking now that AMC is a first-class top-level department.
-- ============================================================

UPDATE purchase_requests
  SET department = 'amc'
  WHERE expenditure_type = 'amc'
    AND department = 'maintenance';

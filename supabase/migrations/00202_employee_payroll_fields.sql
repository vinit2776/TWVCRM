-- Extend employees table with payroll-relevant fields.
-- These are separate from COSEC access fields to keep concerns clean.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS date_of_joining date,
  ADD COLUMN IF NOT EXISTS employment_type text NOT NULL DEFAULT 'full_time',
  ADD COLUMN IF NOT EXISTS pan_number      text;

-- employment_type values: full_time | part_time | intern
-- pan_number needed for TDS Section 192 reporting

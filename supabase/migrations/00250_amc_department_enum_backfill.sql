-- ============================================================
-- Migration 00250: Add 'amc' to procurement_department enum
--
-- Context: AMC was previously tracked as expenditure_type='amc'
-- with department='maintenance'. In migration 00249 AMC became
-- a first-class top-level department. This migration adds 'amc'
-- to the ENUM so new MRs can be saved with department='amc'.
--
-- NOTE: PostgreSQL does not allow referencing a newly added enum
-- value within the same transaction. The backfill UPDATE that sets
-- existing rows to department='amc' lives in migration 00251,
-- which runs in a separate transaction after this one commits.
-- ============================================================

-- Add 'amc' to the enum (idempotent in PG12+)
ALTER TYPE procurement_department ADD VALUE IF NOT EXISTS 'amc';

-- Add lock_in_months to contracts table.
-- Previously the lock-in period was a UI-only helper used to constrain the
-- notice period field; it was never persisted. This migration adds the column
-- so it is stored, displayed on the contract detail page, and included in
-- the audit trail going forward.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS lock_in_months INTEGER;

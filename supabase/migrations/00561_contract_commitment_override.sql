-- Record when an admin creates or edits a contract with a term, lock-in or
-- notice period that differs from what the linked proposal offered.
--
-- A contract's term / lock-in / notice period are now prefilled from the
-- proposal (proposals.tenure_months / lock_in_months / notice_period_months,
-- migration 00560) and locked. Only an admin can override them, with a
-- reason; these columns keep that decision visible on the contract itself
-- (the full before/after also goes to audit_trail).
--
-- Rollback:
--   ALTER TABLE contracts
--     DROP COLUMN IF EXISTS commitment_override_reason,
--     DROP COLUMN IF EXISTS commitment_overridden_by,
--     DROP COLUMN IF EXISTS commitment_overridden_at;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS commitment_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS commitment_overridden_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS commitment_overridden_at TIMESTAMPTZ;

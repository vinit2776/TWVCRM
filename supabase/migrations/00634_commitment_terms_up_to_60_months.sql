-- Term and lock-in on a proposal may now run up to 60 months (was 18).
-- Notice period stays capped at 18. Contracts have no such CHECK.
-- Rollback: re-add the BETWEEN 1 AND 18 checks (fails if any row exceeds 18).
ALTER TABLE proposals
  DROP CONSTRAINT IF EXISTS proposals_tenure_months_check,
  DROP CONSTRAINT IF EXISTS proposals_lock_in_months_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_tenure_months_check CHECK (tenure_months BETWEEN 1 AND 60),
  ADD CONSTRAINT proposals_lock_in_months_check CHECK (lock_in_months BETWEEN 1 AND 60);

-- Capture the commitment terms offered on a proposal as structured fields.
--
-- Until now term / lock-in / notice period only existed as static text inside
-- the proposal's terms_and_conditions ("Term 1 year (Lock-in 11 months)"), so
-- nothing guaranteed the contract issued later matched what the customer
-- accepted. The proposal T&C lines for these terms are now generated from
-- these columns (src/lib/proposal-terms.ts).
--
-- Nullable on purpose: existing proposals keep NULL and their stored T&C text
-- untouched. New proposals are required to set all three (enforced by
-- createProposalSchema). Bounds mirror contracts.lock_in_months (1-18).
--
-- Rollback:
--   ALTER TABLE proposals
--     DROP COLUMN IF EXISTS tenure_months,
--     DROP COLUMN IF EXISTS lock_in_months,
--     DROP COLUMN IF EXISTS notice_period_months;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS tenure_months INTEGER
    CHECK (tenure_months BETWEEN 1 AND 18),
  ADD COLUMN IF NOT EXISTS lock_in_months INTEGER
    CHECK (lock_in_months BETWEEN 1 AND 18),
  ADD COLUMN IF NOT EXISTS notice_period_months INTEGER
    CHECK (notice_period_months BETWEEN 0 AND 18),
  ADD CONSTRAINT proposals_lock_in_within_tenure
    CHECK (lock_in_months IS NULL OR tenure_months IS NULL OR lock_in_months <= tenure_months);

-- Deposit accounting inbox: lets accounts reconcile original security
-- deposits and top-ups against Tally by uploading the Tally receipt PDF.
-- Uploading the receipt IS what marks a deposit "accounted" — enforced by
-- a CHECK constraint, not just app-layer discipline, so there's no way to
-- clear an item without leaving evidence behind.
--
-- Replaces the old deposit_accounted toggle on proposals (previously
-- surfaced via the Billing > Proposals tab with no proof requirement) —
-- that UI is being removed in the same change. deposit_accounted /
-- deposit_accounted_at / deposit_accounted_by already existed; this only
-- adds the proof-path column and the constraint.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_accounted_proof_path TEXT;

ALTER TABLE proposals
  DROP CONSTRAINT IF EXISTS deposit_accounted_requires_proof;
ALTER TABLE proposals
  ADD CONSTRAINT deposit_accounted_requires_proof
  CHECK (deposit_accounted IS NOT TRUE OR deposit_accounted_proof_path IS NOT NULL);

-- The deposit_topups half of this migration (accounted/accounted_at/accounted_by/
-- accounted_proof_path + its CHECK constraint) moved to 00368_deposit_topups.sql,
-- appended after that file's CREATE TABLE — deposit_topups doesn't exist yet at
-- this point in a from-scratch migration run.

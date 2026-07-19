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

ALTER TABLE deposit_topups
  ADD COLUMN IF NOT EXISTS accounted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS accounted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accounted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS accounted_proof_path TEXT;

ALTER TABLE deposit_topups
  DROP CONSTRAINT IF EXISTS deposit_topup_accounted_requires_proof;
ALTER TABLE deposit_topups
  ADD CONSTRAINT deposit_topup_accounted_requires_proof
  CHECK (accounted IS NOT TRUE OR accounted_proof_path IS NOT NULL);

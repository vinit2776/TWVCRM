-- ─────────────────────────────────────────────────────────────────────────────
-- 00393_proposal_deposit_exception.sql
-- Exception override of a proposal's required security deposit — distinct
-- from deposit_credit_amount (which nets an already-held credit) and from
-- deposit_adjustments (00359/00360/00368, which draws the deposit DOWN
-- against a billing statement at settlement time). This is a signed delta
-- applied to security_deposit_amount itself, for one-off exceptions
-- (e.g. waiving part of a deposit, or topping it up before collection).
-- security_deposit_amount stays untouched as the true baseline, same as the
-- credit field's convention.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_exception_amount NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_exception_reason TEXT,
  ADD COLUMN IF NOT EXISTS deposit_exception_proof_url TEXT,
  ADD COLUMN IF NOT EXISTS deposit_exception_applied_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS deposit_exception_applied_at TIMESTAMPTZ;

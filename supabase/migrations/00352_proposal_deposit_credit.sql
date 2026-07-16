-- ============================================================
-- Migration 00352: Proposal deposit credit
--
-- Lets an admin/manager net off a security deposit already held
-- from a prior (e.g. terminated) contract against a new proposal's
-- required deposit, without overwriting the required amount itself.
-- security_deposit_amount stays the true required deposit (history
-- preserved); the deposit-link/email flow subtracts the credit to
-- arrive at the balance actually collected.
-- ============================================================

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_credit_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS deposit_credit_reason TEXT,
  ADD COLUMN IF NOT EXISTS deposit_credit_proof_url TEXT,
  ADD COLUMN IF NOT EXISTS deposit_credit_applied_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS deposit_credit_applied_at TIMESTAMPTZ;

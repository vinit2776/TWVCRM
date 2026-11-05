-- Auto-renewal part 3: a revised (negotiated) rate for the NEXT term only.
--
-- The agreement's escalation stays on agreement_escalation_percentage. When staff
-- agree a different rate with the customer before the term rolls, it is stored
-- here until the renewal is prepared, then copied onto that term as its
-- escalation_percentage. It never changes the base agreement.
--
-- No new table, so no new RLS: these columns inherit the contracts policies.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS auto_renew_escalation_override NUMERIC(5,2)
    CHECK (auto_renew_escalation_override IS NULL OR (auto_renew_escalation_override >= 0 AND auto_renew_escalation_override <= 100)),
  ADD COLUMN IF NOT EXISTS auto_renew_revised_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_renew_revised_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS auto_renew_revision_reason TEXT;

COMMENT ON COLUMN contracts.auto_renew_escalation_override IS
  'Negotiated escalation % for the next term only. NULL = apply the agreement''s programmed escalation.';

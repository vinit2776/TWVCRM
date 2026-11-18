-- VO proposals (decision D5d): the customer gives the signer's name, email and
-- phone when they accept online, so staff do not have to chase them afterwards.
-- Nullable, additive. Aadhaar is NOT stored here (handled separately).
--
-- Rollback:
--   ALTER TABLE proposals DROP COLUMN IF EXISTS signer_name,
--     DROP COLUMN IF EXISTS signer_email, DROP COLUMN IF EXISTS signer_phone;
--
-- proposals already has RLS enabled; no new table, so no new policy.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS signer_name text,
  ADD COLUMN IF NOT EXISTS signer_email text,
  ADD COLUMN IF NOT EXISTS signer_phone text;

COMMENT ON COLUMN proposals.signer_name IS 'VO kind: who will sign, as given by the customer when accepting.';

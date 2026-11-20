-- Leads: remember why a lead was marked junk.
--
-- Junk had no stored reason: the choice only lived in the audit log. Existing junk leads stay NULL
-- (reason unknown). Additive and idempotent. Rollback:
--   ALTER TABLE leads DROP COLUMN IF EXISTS junk_reason;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS junk_reason text
  CHECK (junk_reason IS NULL OR junk_reason IN ('job_seeker', 'vendor_or_pitch', 'spam_or_test', 'wrong_number', 'duplicate', 'other'));

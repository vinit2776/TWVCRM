-- Deposit request history on the proposal page needs two things the log
-- couldn't record:
--   1. 'manual' channel — a deposit request PDF downloaded to share outside the
--      CRM (WhatsApp from a phone, someone's own inbox). Nothing was sent by us,
--      but the request was made and the reminder ladder started.
--   2. cc — who was copied on an email. Previously only the To address was kept.

ALTER TABLE communications_log DROP CONSTRAINT IF EXISTS communications_log_channel_check;
ALTER TABLE communications_log
  ADD CONSTRAINT communications_log_channel_check
  CHECK (channel IN ('email', 'whatsapp', 'sms', 'manual'));

ALTER TABLE communications_log ADD COLUMN IF NOT EXISTS cc TEXT[];

-- Rollback:
--   DELETE FROM communications_log WHERE channel = 'manual';
--   ALTER TABLE communications_log DROP CONSTRAINT communications_log_channel_check;
--   ALTER TABLE communications_log ADD CONSTRAINT communications_log_channel_check
--     CHECK (channel IN ('email', 'whatsapp', 'sms'));
--   ALTER TABLE communications_log DROP COLUMN cc;

-- ============================================================
-- Migration 00356: Activity WhatsApp reminder sent timestamp
--
-- Guards the lead-reminder-whatsapp cron against double-sending:
-- the cron runs every 5 minutes and must never message the same
-- follow-up twice, so it atomically claims a row by setting this
-- column (UPDATE ... WHERE followup_wa_reminder_sent_at IS NULL)
-- before sending, not after.
-- ============================================================

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS followup_wa_reminder_sent_at TIMESTAMPTZ;

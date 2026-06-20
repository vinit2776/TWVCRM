-- Add channel column to whatsapp_messages so both WA and SMS logs are queryable
-- The logMessage() helper already passes channel in the insert; this column makes it land.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'sms'));

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_channel
  ON whatsapp_messages(channel);

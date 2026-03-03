-- Add channel column to distinguish WhatsApp vs SMS messages in the log
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'sms'));

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_channel
  ON whatsapp_messages(channel);

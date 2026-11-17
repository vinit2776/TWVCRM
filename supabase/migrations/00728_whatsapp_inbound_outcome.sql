-- What the CRM did with each inbound WhatsApp message, stored on the message itself.
-- Until now the intake decided (new lead, re-enquiry, follow-up, junk, held, ignored) and the
-- decision was thrown away, so nobody could check whether a message had arrived or where it went.
-- Older rows stay NULL and are shown as "before tracking". Rollback: drop the columns and index.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS intake_outcome   TEXT,
  ADD COLUMN IF NOT EXISTS intake_kind      TEXT,
  ADD COLUMN IF NOT EXISTS enquiry_reference TEXT,
  ADD COLUMN IF NOT EXISTS is_ad_reply      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ad_headline      TEXT;

-- intake_outcome: new_lead | re_enquiry | joined_open_enquiry | logged_only | request_recorded
--                 | spam_stashed | held_for_review | labelled_ignored | not_processed | intake_error
-- enquiry_reference: the TWV-E-#### the message landed on, when it landed on one.

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_inbound_log
  ON whatsapp_messages (created_at DESC)
  WHERE direction = 'inbound';

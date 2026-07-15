-- Unified log of outbound customer communications (email/WhatsApp/SMS) with
-- full content + attachment reference, so a post-send confirmation dialog
-- and the lead activity timeline can show exactly what was sent — not just
-- that "something was sent" (toasts are missable and carry no content).

CREATE TABLE IF NOT EXISTS communications_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT        NOT NULL CHECK (entity_type IN ('billing_statement', 'contract', 'proposal', 'booking', 'lead')),
  entity_id       UUID        NOT NULL,
  channel         TEXT        NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms')),
  recipient       TEXT        NOT NULL,
  subject         TEXT,                                        -- email only
  body            TEXT        NOT NULL,                         -- rendered HTML (email) or message text (WhatsApp/SMS)
  attachment_url  TEXT,                                         -- signed/public Supabase Storage URL, if a PDF was attached
  attachment_name TEXT,
  status          TEXT        NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  error_message   TEXT,
  sent_by         UUID        REFERENCES users(id),             -- null for cron-triggered sends
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_communications_log_entity
  ON communications_log(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_communications_log_created_at
  ON communications_log(created_at DESC);

ALTER TABLE communications_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view communications log"
  ON communications_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage communications log"
  ON communications_log FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

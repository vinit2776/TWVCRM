-- WhatsApp message log table
-- Stores all outbound and inbound WhatsApp messages for audit and retry

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id  TEXT,                                        -- Meta's message ID (for status tracking)
  direction      TEXT        NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  to_number      TEXT,                                        -- E.164 format, e.g. 919876543210
  from_number    TEXT,                                        -- populated for inbound messages
  template_name  TEXT,                                        -- template used (outbound only)
  message_body   TEXT,                                        -- raw body (inbound) or rendered body
  status         TEXT        NOT NULL DEFAULT 'sent'          -- sent | delivered | read | failed
                 CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  entity_type    TEXT,                                        -- 'lead' | 'booking' | 'billing_statement'
  entity_id      UUID,                                        -- FK to the related record
  error_message  TEXT,                                        -- populated if status = failed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for looking up messages by entity (e.g. "all WhatsApps sent for booking X")
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_entity
  ON whatsapp_messages(entity_type, entity_id);

-- Index for status webhook updates by Meta message ID
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_wa_id
  ON whatsapp_messages(wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_whatsapp_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_whatsapp_messages_updated_at
  BEFORE UPDATE ON whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION update_whatsapp_messages_updated_at();

-- RLS: staff can read; only service_role can insert/update
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view whatsapp messages"
  ON whatsapp_messages FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage whatsapp messages"
  ON whatsapp_messages FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

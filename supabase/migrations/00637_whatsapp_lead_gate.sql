-- 00637_whatsapp_lead_gate.sql
-- Keeps non-lead chatter on the connected WhatsApp number out of the Enquiry Log without ever
-- dropping a message:
--   * whatsapp_number_labels   numbers a person has labelled (staff, vendor, a customer's team
--                              member, or "not a lead"). Future messages from them never open an enquiry.
--   * whatsapp_possible_leads  messages from an UNKNOWN number the rules could not judge. Held here
--                              (no lead is created) until someone taps "It's a lead" or "Not a lead".
--   * whatsapp_sender_label()  one lookup for the webhook: a stored label, else "staff" when the
--                              digits match an active user or an employee.

CREATE TABLE IF NOT EXISTS whatsapp_number_labels (
  last10      text PRIMARY KEY,
  label       text NOT NULL CHECK (label IN ('staff', 'vendor', 'customer_team', 'not_lead')),
  name        text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE whatsapp_number_labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_number_labels_select ON whatsapp_number_labels
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS whatsapp_possible_leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  last10        text NOT NULL,
  mobile        text NOT NULL,
  profile_name  text,
  message_type  text NOT NULL DEFAULT 'text',
  messages      jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason        text,
  status        text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'promoted', 'dismissed')),
  first_at      timestamptz NOT NULL DEFAULT now(),
  last_at       timestamptz NOT NULL DEFAULT now(),
  alerted_at    timestamptz,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  lead_id       uuid REFERENCES leads(id) ON DELETE SET NULL
);
-- One held conversation per number at a time; later messages join it.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_possible_leads_one_held
  ON whatsapp_possible_leads (last10) WHERE status = 'held';
ALTER TABLE whatsapp_possible_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_possible_leads_select ON whatsapp_possible_leads
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION whatsapp_sender_label(p_last10 text)
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT label FROM whatsapp_number_labels WHERE last10 = p_last10),
    CASE WHEN length(p_last10) = 10 AND (
      EXISTS (SELECT 1 FROM users u
              WHERE u.is_active AND right(regexp_replace(coalesce(u.phone, ''), '\D', '', 'g'), 10) = p_last10)
      OR EXISTS (SELECT 1 FROM employees e
              WHERE e.is_active AND right(regexp_replace(coalesce(e.phone, ''), '\D', '', 'g'), 10) = p_last10)
    ) THEN 'staff' END
  );
$$;

-- Rollback: DROP FUNCTION whatsapp_sender_label(text); DROP TABLE whatsapp_possible_leads; DROP TABLE whatsapp_number_labels;

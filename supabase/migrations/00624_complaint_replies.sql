-- 00624_complaint_replies.sql
-- Every WhatsApp message the CRM sends a customer about a complaint (acknowledgement, update or
-- question, closing message with the rating link), including ones that could not be sent, so the
-- team can see what the customer has been told. Rows are written by the complaints APIs only.

CREATE TABLE IF NOT EXISTS complaint_replies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id  uuid NOT NULL REFERENCES customer_complaints(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('received', 'update', 'resolved')),
  message       text,
  -- sent: MSG91 accepted it. failed: MSG91 rejected it. skipped: not attempted (template not
  -- configured, no phone number, already sent), with the reason in detail.
  status        text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  detail        text,
  sent_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS complaint_replies_complaint_idx ON complaint_replies (complaint_id, created_at);

ALTER TABLE complaint_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "complaint_replies_select_authenticated" ON complaint_replies;
CREATE POLICY "complaint_replies_select_authenticated"
  ON complaint_replies FOR SELECT TO authenticated USING (true);

-- Rollback: DROP TABLE complaint_replies;

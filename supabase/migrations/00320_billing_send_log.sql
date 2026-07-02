-- Per-recipient send log for proforma (PI) and GST invoice dispatches.
-- Mirrors billing_reminder_sends so accounts can answer "what have we sent
-- this customer, and to whom" for every billing communication type, not
-- just reminders. Feeds the lead-page communication timeline.

CREATE TABLE IF NOT EXISTS billing_send_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id  uuid NOT NULL REFERENCES billing_statements(id) ON DELETE CASCADE,
  send_type             text NOT NULL CHECK (send_type IN ('proforma', 'gst_invoice')),
  recipient             text NOT NULL,        -- email address
  status                text NOT NULL CHECK (status IN ('sent', 'failed')),
  error                 text,                 -- failure detail when status='failed'
  triggered_by          text NOT NULL CHECK (triggered_by IN ('cron', 'manual')),
  triggered_by_user_id  uuid REFERENCES users(id),  -- NULL for cron, set for manual sends
  sent_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_send_log_statement
  ON billing_send_log (billing_statement_id, sent_at DESC);

ALTER TABLE billing_send_log ENABLE ROW LEVEL SECURITY;

-- Accounts / managers / admins can read the send log for the same reason
-- they can read billing_reminder_sends — answering "what have we sent?"
CREATE POLICY "Staff can read billing send log"
  ON billing_send_log FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
      AND users.role IN ('admin', 'manager', 'accounts')
      AND users.is_active = true
    )
  );

-- Inserts happen via service role only (send-proforma + inbox-send routes),
-- so no insert policy for authenticated users is needed.

COMMENT ON TABLE billing_send_log IS
  'Per-recipient activity log for proforma and GST invoice sends. Written by send-proforma.ts and /api/billing-statements/[id]/inbox-send.';

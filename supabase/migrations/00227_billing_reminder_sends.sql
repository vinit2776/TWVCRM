-- Per-send activity log for the customer payment-reminder cron + manual
-- "Send Reminder Now" button. Lets accounts see exactly what was sent to
-- whom and when before making a follow-up call, and surfaces channel-level
-- failures (e.g. WhatsApp delivery failed, email bounced).
--
-- One row per channel send. A single ladder stage that fires both email and
-- WhatsApp produces two rows.

CREATE TABLE IF NOT EXISTS billing_reminder_sends (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id  uuid NOT NULL REFERENCES billing_statements(id) ON DELETE CASCADE,
  stage_index           int NOT NULL,         -- 0..5 matching STAGES[] in the cron
  stage_label           text NOT NULL,        -- e.g. "Friendly reminder"
  channel               text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms')),
  recipient             text NOT NULL,        -- email address or phone number
  status                text NOT NULL CHECK (status IN ('sent', 'failed')),
  error                 text,                 -- failure detail when status='failed'
  triggered_by          text NOT NULL CHECK (triggered_by IN ('cron', 'manual')),
  triggered_by_user_id  uuid REFERENCES users(id),  -- NULL for cron, set for manual sends
  sent_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_reminder_sends_statement
  ON billing_reminder_sends (billing_statement_id, sent_at DESC);

ALTER TABLE billing_reminder_sends ENABLE ROW LEVEL SECURITY;

-- Accounts / managers / admins can read the reminder log to answer
-- "what have we already sent this customer?" before calling them.
CREATE POLICY "Staff can read reminder sends"
  ON billing_reminder_sends FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
      AND users.role IN ('admin', 'manager', 'accounts')
      AND users.is_active = true
    )
  );

-- Inserts happen via service role only (cron + manual reminder endpoint),
-- so no insert policy for authenticated users is needed.

COMMENT ON TABLE billing_reminder_sends IS
  'Activity log for customer payment reminders. One row per channel send. Written by /api/cron/payment-reminder and /api/billing-statements/[id]/send-reminder.';

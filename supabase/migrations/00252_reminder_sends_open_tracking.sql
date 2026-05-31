-- Open tracking for payment reminder emails.
--
-- Each email send gets a unique tracking_id (UUID). The reminder HTML embeds a
-- 1×1 pixel at /api/tracking/email-open?id=<tracking_id>. When the customer
-- opens the email their client loads the pixel, hitting that endpoint which
-- marks this row as opened.
--
-- Works with our existing Gmail SMTP delivery — no dependency on Resend's
-- domain-verified open tracking. Same accuracy trade-offs as any tracking pixel
-- (image-blocking clients won't fire it, but Gmail web/desktop does by default).

ALTER TABLE billing_reminder_sends
  ADD COLUMN IF NOT EXISTS tracking_id  uuid,
  ADD COLUMN IF NOT EXISTS opened_at    timestamptz;

-- Extend the status CHECK to allow 'opened'.
ALTER TABLE billing_reminder_sends
  DROP CONSTRAINT IF EXISTS billing_reminder_sends_status_check;

ALTER TABLE billing_reminder_sends
  ADD CONSTRAINT billing_reminder_sends_status_check
    CHECK (status IN ('sent', 'failed', 'opened'));

-- Fast lookup by tracking_id when the pixel fires.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_reminder_sends_tracking_id
  ON billing_reminder_sends (tracking_id)
  WHERE tracking_id IS NOT NULL;

COMMENT ON COLUMN billing_reminder_sends.tracking_id IS
  'UUID embedded in the email tracking pixel URL. NULL for non-email channels (WhatsApp, SMS).';
COMMENT ON COLUMN billing_reminder_sends.opened_at IS
  'When the tracking pixel was first loaded — proxy for email open. NULL = not yet opened or pixel blocked.';

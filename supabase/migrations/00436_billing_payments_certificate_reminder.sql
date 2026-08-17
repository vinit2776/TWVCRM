-- TDS Receivable: manual certificate-chase tracking. Accounts can nudge a
-- client for their Form 16A from the TDS Receivable tab; these columns back
-- the Pending/Overdue status badge and "last chased" context. The chase
-- itself is a manual button click, never an automated cron — see
-- tds_certificate_path's comment (00332): the certificate stays optional
-- and is never required to settle the payment.
ALTER TABLE billing_payments
  ADD COLUMN IF NOT EXISTS certificate_reminder_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_certificate_reminder_sent_at timestamptz;

COMMENT ON COLUMN billing_payments.certificate_reminder_count IS
  'How many times accounts has manually chased this client for their Form 16A via the TDS Receivable tab.';
COMMENT ON COLUMN billing_payments.last_certificate_reminder_sent_at IS
  'When the certificate chase email was last sent. Null if never chased.';

-- Track outgoing email counts per calendar day (sent via CRM SMTP mailer).
-- Used by the Infrastructure page to show Google Workspace daily send usage.

CREATE TABLE IF NOT EXISTS email_daily_stats (
  date         DATE    PRIMARY KEY,
  sent_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE email_daily_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read email_daily_stats"
  ON email_daily_stats FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Atomic upsert helper — called from the mailer with SECURITY DEFINER
-- so the service-role bypass is not needed at the application layer.
CREATE OR REPLACE FUNCTION increment_email_count(
  p_date    DATE,
  p_success BOOLEAN DEFAULT TRUE
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO email_daily_stats (date, sent_count, failed_count)
    VALUES (
      p_date,
      CASE WHEN p_success THEN 1 ELSE 0 END,
      CASE WHEN p_success THEN 0 ELSE 1 END
    )
  ON CONFLICT (date) DO UPDATE SET
    sent_count   = email_daily_stats.sent_count   + CASE WHEN p_success THEN 1 ELSE 0 END,
    failed_count = email_daily_stats.failed_count + CASE WHEN p_success THEN 0 ELSE 1 END;
END;
$$;

-- messaging_health_state: last-known health of each outbound messaging channel
-- (WhatsApp / SMS via MSG91), written by /api/cron/messaging-health.
--
-- Two jobs:
--   1. Transition tracking — last_alerted_status lets the cron email only when
--      a channel CHANGES state, rather than re-alerting every 30 minutes for
--      the duration of an outage (the unifi_ap_alert_state pattern).
--   2. Cheap reads for /api/health — UptimeRobot polls that endpoint every
--      minute, so it reads this precomputed row instead of re-running a
--      failure-rate aggregate over whatsapp_messages on each poll.

CREATE TABLE IF NOT EXISTS messaging_health_state (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             TEXT        NOT NULL UNIQUE CHECK (channel IN ('whatsapp', 'sms')),
  -- idle = too few sends in the window to judge; not a failure.
  status              TEXT        NOT NULL CHECK (status IN ('ok', 'degraded', 'down', 'idle')),
  fail_rate           NUMERIC(5,4) NOT NULL DEFAULT 0,
  sample_size         INTEGER     NOT NULL DEFAULT 0,
  failed_count        INTEGER     NOT NULL DEFAULT 0,
  -- Most frequent error string in the window — this is what makes the alert
  -- actionable ("no subscription assigned" => the MSG91 plan lapsed).
  dominant_error      TEXT,
  -- [{ name, status, reason }] for templates referenced in code that are not
  -- approved in MSG91. Refreshed from the MSG91 template API.
  template_issues     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  templates_checked_at TIMESTAMPTZ,
  -- The status we last emailed about, so a sustained outage alerts once.
  last_alerted_status TEXT,
  last_alerted_at     TIMESTAMPTZ,
  last_checked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER update_messaging_health_state_updated_at
  BEFORE UPDATE ON messaging_health_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE messaging_health_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read messaging_health_state"
  ON messaging_health_state FOR SELECT USING (auth.uid() IS NOT NULL);

-- The failure-rate aggregate scans outbound rows in a trailing time window.
-- Without this the cron does a seq scan over the whole table every 30 min.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_direction_created
  ON whatsapp_messages (direction, created_at DESC);

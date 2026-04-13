-- Track last successful run of each cron job
-- Allows detection of silent cron failures
CREATE TABLE IF NOT EXISTS cron_health (
  job         TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_status TEXT NOT NULL DEFAULT 'ok',
  details     JSONB
);

INSERT INTO cron_health (job) VALUES
  ('petty-cash/day-book'),
  ('digest'),
  ('billing/auto-generate'),
  ('cron/db-backup'),
  ('cron/storage-backup')
ON CONFLICT (job) DO NOTHING;

-- Upkeep of Waiting for space: an enquiry that has waited a long time is asked about again, and a
-- "look again" date becomes a reminder task. `last_reviewed_at` restarts the clock when someone says
-- 'still waiting'; `review_notified_at` and `look_again_notified_at` make each reminder go once.
-- `space_review_mode` is 'dry_run' by default (the daily cron reports what it would remind about,
-- creates and sends nothing); 'live' reminds; 'off' stops it. `space_review_days` is how long an
-- enquiry waits before it is due a review.
-- Rollback:
--   ALTER TABLE parked_enquiries DROP COLUMN IF EXISTS last_reviewed_at, DROP COLUMN IF EXISTS review_notified_at,
--     DROP COLUMN IF EXISTS look_again_notified_at;
--   DELETE FROM app_settings WHERE key IN ('space_review_mode', 'space_review_days');

ALTER TABLE parked_enquiries
  ADD COLUMN IF NOT EXISTS last_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS look_again_notified_at timestamptz;

INSERT INTO app_settings (key, value) VALUES ('space_review_mode', 'dry_run') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('space_review_days', '60') ON CONFLICT (key) DO NOTHING;

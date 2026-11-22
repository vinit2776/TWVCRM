-- The space matcher: when seats free up (a contract ends, a centre opens), enquiries waiting for
-- space that now fit are flagged 'space available' and the person who parked them is told. A person
-- still takes them out of Waiting; nothing is sent to the customer.
-- `matched_at` / `matched_note` record when and what fit. The switch `space_match_mode` is 'dry_run'
-- by default (reports what would be flagged, changes nothing); 'live' flags and notifies; 'off' stops it.
-- Rollback:
--   ALTER TABLE parked_enquiries DROP COLUMN IF EXISTS matched_at, DROP COLUMN IF EXISTS matched_note;
--   DELETE FROM app_settings WHERE key = 'space_match_mode';

ALTER TABLE parked_enquiries
  ADD COLUMN IF NOT EXISTS matched_at timestamptz,
  ADD COLUMN IF NOT EXISTS matched_note text;

INSERT INTO app_settings (key, value)
VALUES ('space_match_mode', 'dry_run')
ON CONFLICT (key) DO NOTHING;

-- 00670_tour_outcome.sql
-- What happened at a tour: came, didn't come, or cancelled. Until now a tour only had a free-text
-- note on "complete tour", and a booked tour that passed without anyone updating it left its lead on
-- Tour Scheduled for good. The Leads -> Tours tab asks for the outcome on every past tour.
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS tour_outcome text CHECK (tour_outcome IN ('came', 'no_show', 'cancelled')),
  ADD COLUMN IF NOT EXISTS tour_outcome_at timestamptz,
  ADD COLUMN IF NOT EXISTS tour_outcome_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- The Tours tab reads tours by date.
CREATE INDEX IF NOT EXISTS activities_tour_start_idx
  ON activities (meeting_start_at)
  WHERE type = 'tour';

-- Cut-off for "Needs update": only tours that started on or after this are asked for an outcome.
-- Older tours are listed as "Done, outcome not recorded" and left out of the came / didn't come
-- numbers, so history is not rewritten and the queue does not open with hundreds of old tours.
-- Set to a week before this migration is applied, so tours from the last few days still ask.
-- Change it by updating the row (ISO timestamp). If the row is missing or unparseable, nothing is
-- asked for (the fail-safe direction).
INSERT INTO app_settings (key, value)
VALUES ('tour_outcome_effective_from', to_char((now() - interval '7 days') AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;

-- Existing RLS on activities already covers the new columns. Writes go through the API.

-- Rollback:
--   DROP INDEX IF EXISTS activities_tour_start_idx;
--   ALTER TABLE activities DROP COLUMN IF EXISTS tour_outcome, DROP COLUMN IF EXISTS tour_outcome_at, DROP COLUMN IF EXISTS tour_outcome_by;
--   DELETE FROM app_settings WHERE key = 'tour_outcome_effective_from';

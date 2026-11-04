-- Tours: who will host the tour, and whether the "2 hours to go" reminder has gone out.
-- Both live on the tour activity itself (activities.type = 'tour').
ALTER TABLE activities ADD COLUMN IF NOT EXISTS tour_host_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS tour_reminder_sent_at timestamptz;

-- The reminder job looks for tours that start soon and have not been reminded.
CREATE INDEX IF NOT EXISTS idx_activities_tour_reminder
  ON activities (meeting_start_at)
  WHERE type = 'tour' AND tour_reminder_sent_at IS NULL;

-- No new policy: activities already has RLS; these are ordinary columns of the same rows.

-- Rollback:
--   DROP INDEX IF EXISTS idx_activities_tour_reminder;
--   ALTER TABLE activities DROP COLUMN IF EXISTS tour_reminder_sent_at, DROP COLUMN IF EXISTS tour_host_id;

-- Track who acted on a follow-up (close or reschedule) and when.
-- Set by PATCH /api/activities/:id whenever a follow-up is closed or rescheduled.
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS follow_up_actioned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS follow_up_actioned_at TIMESTAMPTZ;

-- Sparse index — only rows where a follow-up action has been recorded
CREATE INDEX IF NOT EXISTS idx_activities_followup_actor
  ON activities(follow_up_actioned_by)
  WHERE follow_up_actioned_by IS NOT NULL;

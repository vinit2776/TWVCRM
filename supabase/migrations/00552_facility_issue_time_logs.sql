-- Manual time tracking on facility issues/tasks. Append-only worklog (no
-- update/delete) so a report can sum entries over a date range per user —
-- a single cumulative field on facility_issues wouldn't support that.
-- RLS mirrors facility_issue_events (00116_facility_issues.sql): wide open
-- at the DB layer, role gating enforced in the API route instead.
CREATE TABLE IF NOT EXISTS facility_issue_time_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id    UUID NOT NULL REFERENCES facility_issues(id) ON DELETE CASCADE,
  logged_by   UUID NOT NULL REFERENCES public.users(id),
  minutes     INTEGER NOT NULL CHECK (minutes > 0),
  note        TEXT,
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_time_logs_issue ON facility_issue_time_logs(issue_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_fac_time_logs_user  ON facility_issue_time_logs(logged_by, logged_at);

ALTER TABLE facility_issue_time_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_time_logs_select" ON facility_issue_time_logs;
DROP POLICY IF EXISTS "fac_time_logs_insert" ON facility_issue_time_logs;

CREATE POLICY "fac_time_logs_select" ON facility_issue_time_logs
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "fac_time_logs_insert" ON facility_issue_time_logs
  FOR INSERT TO authenticated WITH CHECK (true);

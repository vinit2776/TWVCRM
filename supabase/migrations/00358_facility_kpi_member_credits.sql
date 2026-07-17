-- Per-user KPI credit per ticket, so department-roster collaborators can share
-- in a resolved ticket's score (weighted below the primary assignee) without
-- changing facility_issues.kpi_points, which stays the ticket-level total.
-- Recomputed (rows deleted + reinserted) every time kpi_points is recomputed
-- — on resolve, on satisfaction top-up, on reopen, and on pass-card override.

CREATE TABLE IF NOT EXISTS facility_issue_kpi_credits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id      UUID NOT NULL REFERENCES facility_issues(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('primary', 'member')),
  points        NUMERIC(6,2) NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(issue_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_fikc_issue ON facility_issue_kpi_credits(issue_id);
CREATE INDEX IF NOT EXISTS idx_fikc_user  ON facility_issue_kpi_credits(user_id);

ALTER TABLE facility_issue_kpi_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fikc_select" ON facility_issue_kpi_credits;
DROP POLICY IF EXISTS "fikc_insert" ON facility_issue_kpi_credits;
DROP POLICY IF EXISTS "fikc_delete" ON facility_issue_kpi_credits;

-- All facility staff can see credit rows on any issue (matches
-- facility_issue_collaborators' read policy). Insert/delete happen from the
-- status/satisfaction/pass-card routes whenever kpi_points is recomputed —
-- the API layer, not RLS, gates who can trigger those transitions.
CREATE POLICY "fikc_select" ON facility_issue_kpi_credits
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "fikc_insert" ON facility_issue_kpi_credits
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "fikc_delete" ON facility_issue_kpi_credits
  FOR DELETE TO authenticated USING (true);

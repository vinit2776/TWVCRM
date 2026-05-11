-- Additional assignees (collaborators) for facility issues.
-- The primary assignee remains in facility_issues.assigned_to for SLA ownership.
-- This table tracks secondary people who need to be involved.
CREATE TABLE IF NOT EXISTS facility_issue_collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES facility_issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by UUID NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(issue_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_fic_issue ON facility_issue_collaborators(issue_id);
CREATE INDEX IF NOT EXISTS idx_fic_user ON facility_issue_collaborators(user_id);

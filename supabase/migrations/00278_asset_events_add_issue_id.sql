-- Link asset events to facility issues (optional)
ALTER TABLE facility_asset_events
  ADD COLUMN issue_id uuid REFERENCES facility_issues(id) ON DELETE SET NULL;

CREATE INDEX idx_asset_events_issue ON facility_asset_events(issue_id)
  WHERE issue_id IS NOT NULL;

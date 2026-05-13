-- Fix: Enable RLS on three tables flagged by Supabase security advisor
-- (tds_sections, notifications, facility_issue_collaborators)

-- ── 1. tds_sections ──────────────────────────────────────────────────────────
-- Static reference table (TDS section codes + rates). All authenticated users
-- need to read it; only service-role / migrations write to it.
ALTER TABLE tds_sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read tds_sections"
  ON tds_sections FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policies — data is managed via migrations only.

-- ── 2. notifications ─────────────────────────────────────────────────────────
-- Each user may only see and modify their own notification rows.
-- Inserts are performed by server-side API routes using the service role
-- (which bypasses RLS), so no INSERT policy is needed for authenticated users.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notifications"
  ON notifications FOR SELECT
  TO authenticated
  USING (
    user_id IN (
      SELECT id FROM users WHERE auth_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE
  TO authenticated
  USING (
    user_id IN (
      SELECT id FROM users WHERE auth_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT id FROM users WHERE auth_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own notifications"
  ON notifications FOR DELETE
  TO authenticated
  USING (
    user_id IN (
      SELECT id FROM users WHERE auth_id = auth.uid()
    )
  );

-- ── 3. facility_issue_collaborators ──────────────────────────────────────────
-- All authenticated users (facility staff) can see collaborators on any issue.
-- Insert/delete is allowed for authenticated users; the API enforces role
-- checks (only fms/admin can add collaborators).
ALTER TABLE facility_issue_collaborators ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read facility_issue_collaborators"
  ON facility_issue_collaborators FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert facility_issue_collaborators"
  ON facility_issue_collaborators FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete facility_issue_collaborators"
  ON facility_issue_collaborators FOR DELETE
  TO authenticated
  USING (true);

-- Add missing UPDATE RLS policy on facility_issue_collaborators.
-- The table had SELECT, INSERT, and DELETE policies but no UPDATE policy,
-- which caused Supabase upsert (ON CONFLICT DO UPDATE) calls to be silently
-- blocked with a permission error when a collaborator row already existed.
CREATE POLICY "Authenticated users can update facility_issue_collaborators"
  ON facility_issue_collaborators FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

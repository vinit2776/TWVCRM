-- ─────────────────────────────────────────────────────────────────────────────
-- 00199_facility_issues_it_team_rls.sql
--
-- Bug fix: commit 3b069e5 added "it_team" to FACILITY_ROLES.workOnIssues and
-- FACILITY_ROLES.manage in TypeScript, but the corresponding PostgreSQL RLS
-- policies on facility_issues were never updated. This caused any it_team user
-- to pass the TypeScript role guard but have their UPDATE silently blocked by
-- the DB, returning "Cannot coerce the result to a single JSON object" from
-- PostgREST (0 rows returned for .select().single() after a blocked UPDATE).
--
-- Fix: include "it_team" in both fac_issues_update and fac_issues_delete.
-- ─────────────────────────────────────────────────────────────────────────────

-- UPDATE policy: allow it_team to change status, acknowledge, resolve, etc.
DROP POLICY IF EXISTS "fac_issues_update" ON facility_issues;
CREATE POLICY "fac_issues_update" ON facility_issues
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'it_technician', 'it_team', 'fms', 'office_admin', 'floor_manager')
        AND is_active = true
    )
  );

-- DELETE policy: allow it_team to delete issues (matches FACILITY_ROLES.manage)
DROP POLICY IF EXISTS "fac_issues_delete" ON facility_issues;
CREATE POLICY "fac_issues_delete" ON facility_issues
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager', 'it_team')
        AND is_active = true
    )
  );

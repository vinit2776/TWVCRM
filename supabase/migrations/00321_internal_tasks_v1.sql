-- ============================================================
-- 00321: Internal Tasks v1
--
-- Generalizes facility_issues from a facility-only problem-report
-- system into a general internal task/delegation system, per the
-- /office-hours design doc + /plan-eng-review (2026-07-03/04):
--   ~/.gstack/projects/vinit2776-TWVCRM/vinitchordia-main-design-20260702-211234-internal-tasks.md
--
-- Scope (v1, deliberately reduced from the original design):
--   - task_type enum: distinguishes a reported problem from a
--     delegated task. No task_categories / task_recurrence_rules
--     yet (deferred to v2 — see TODOS.md).
--   - RLS fix: fac_issues_update excluded sales_rep/accounts, so a
--     task delegated to either role could be created but never
--     acknowledged or resolved by them (same failure class that
--     migration 00199 already fixed once for it_team). Fixed by
--     adding a self-assignment clause instead of another hardcoded
--     role, so this doesn't recur for the next new role.
--
-- Not in this migration: category_id is already nullable (00279).
-- Push-back reason storage reuses facility_issue_events (event_type
-- + message columns are free-text already) — no schema change needed.
-- ============================================================

-- ---------------------------------------------------------------------------
-- task_type enum + column
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE facility_task_type AS ENUM ('reported_problem', 'delegated_task');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE facility_issues
  ADD COLUMN IF NOT EXISTS task_type facility_task_type NOT NULL DEFAULT 'reported_problem';

CREATE INDEX IF NOT EXISTS idx_fac_issues_task_type ON facility_issues(task_type);

-- ---------------------------------------------------------------------------
-- RLS fix: assignee can always update a task assigned to them
--
-- fac_issues_update previously only allowed a hardcoded role list
-- (admin, manager, it_manager, it_technician, it_team, fms,
-- office_admin, floor_manager) — sales_rep and accounts were absent.
-- Delegation (task_type = 'delegated_task') can target any active
-- user, so the policy needs a role-independent path: you can always
-- update a row assigned to you, regardless of role.
--
-- fac_issues_delete is intentionally NOT changed here — deletion
-- stays admin/it_manager only (per CLAUDE.md: "Void billing
-- statements — admin only" pattern; destructive actions get a
-- narrower gate than mutations you're accountable for).
-- ---------------------------------------------------------------------------

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
    OR assigned_to IN (
      SELECT id FROM public.users WHERE auth_id = auth.uid() AND is_active = true
    )
  );

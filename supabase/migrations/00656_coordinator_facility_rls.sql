-- =====================================================================
-- Migration 00656: let the coordinator role use Facility
-- =====================================================================
-- 00642 added the coordinator role and the app code lets it work on
-- Facility (FACILITY_ROLES.workOnIssues), but these row-level policies
-- name roles explicitly, so the database still refused its writes: adding
-- an asset failed even though the API accepted the request (the same trap
-- as 00199 / 00300 — a role added in TypeScript but not here).
--
-- Each policy below is re-stated exactly as it stands in production with
-- 'coordinator' added. Nothing else about them changes.
--
-- Left out on purpose (settings / commercial data, not day-to-day work):
--   fac_cat_write, checklist_templates_manage, asset_docs_select_commercial.
--
-- Rollback: re-run each statement without 'coordinator'::user_role.
-- =====================================================================

-- Assets: add / edit
ALTER POLICY "fac_assets_write" ON facility_assets
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'it_manager'::user_role, 'it_technician'::user_role, 'fms'::user_role, 'floor_manager'::user_role, 'office_admin'::user_role, 'coordinator'::user_role])
        AND users.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'it_manager'::user_role, 'it_technician'::user_role, 'fms'::user_role, 'floor_manager'::user_role, 'office_admin'::user_role, 'coordinator'::user_role])
        AND users.is_active = true
    )
  );

-- Tasks / work orders: update (assignees could already write)
ALTER POLICY "fac_issues_update" ON facility_issues
  USING (
    (
      EXISTS (
        SELECT 1 FROM users
        WHERE users.auth_id = auth.uid()
          AND users.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'it_manager'::user_role, 'it_technician'::user_role, 'it_team'::user_role, 'fms'::user_role, 'office_admin'::user_role, 'floor_manager'::user_role, 'coordinator'::user_role])
          AND users.is_active = true
      )
    )
    OR (
      assigned_to IN (
        SELECT users.id FROM users
        WHERE users.auth_id = auth.uid() AND users.is_active = true
      )
    )
  );

-- Asset documents: upload, and read the operational tier
ALTER POLICY "asset_docs_insert" ON asset_documents
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'fms'::user_role, 'accounts'::user_role, 'office_admin'::user_role, 'it_manager'::user_role, 'coordinator'::user_role])
    )
  );

ALTER POLICY "asset_docs_select_operational" ON asset_documents
  USING (
    tier = 'operational'::asset_document_tier
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'fms'::user_role, 'it_manager'::user_role, 'it_technician'::user_role, 'coordinator'::user_role])
    )
  );

-- AMC visit checklists
ALTER POLICY "event_checklist_manage" ON amc_event_checklist_items
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'fms'::user_role, 'accounts'::user_role, 'office_admin'::user_role, 'coordinator'::user_role])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'fms'::user_role, 'accounts'::user_role, 'office_admin'::user_role, 'coordinator'::user_role])
    )
  );

-- Recurring tasks: change / remove rules (own rules were already allowed)
ALTER POLICY "task_recurrence_rules_update" ON task_recurrence_rules
  USING (
    created_by IN (
      SELECT users.id FROM users
      WHERE users.auth_id = auth.uid() AND users.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'office_admin'::user_role, 'coordinator'::user_role])
        AND users.is_active = true
    )
  );

ALTER POLICY "task_recurrence_rules_delete" ON task_recurrence_rules
  USING (
    created_by IN (
      SELECT users.id FROM users
      WHERE users.auth_id = auth.uid() AND users.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role = ANY (ARRAY['admin'::user_role, 'manager'::user_role, 'office_admin'::user_role, 'coordinator'::user_role])
        AND users.is_active = true
    )
  );

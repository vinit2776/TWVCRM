-- Migration: 00300_facility_assets_floor_manager_office_admin_rls.sql
--
-- Add floor_manager and office_admin to the facility_assets write RLS policy.
-- These roles were already permitted at the API layer (FACILITY_ROLES.workOnIssues)
-- but the Supabase RLS policy was blocking their writes at the DB level.

DROP POLICY IF EXISTS "fac_assets_write" ON facility_assets;

CREATE POLICY "fac_assets_write" ON facility_assets
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'it_technician', 'fms', 'floor_manager', 'office_admin')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'it_technician', 'fms', 'floor_manager', 'office_admin')
        AND is_active = true
    )
  );

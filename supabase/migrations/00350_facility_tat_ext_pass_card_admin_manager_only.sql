-- Pass-card overrides (flipping a TAT extension's kpi_exempt flag) are now
-- restricted to admin/manager only — office_admin was in the broader
-- "override tier" (assign-to-other, bypass ownership) but shouldn't have
-- this specific power.

DROP POLICY IF EXISTS "fac_tat_ext_update" ON facility_issue_tat_extensions;

CREATE POLICY "fac_tat_ext_update" ON facility_issue_tat_extensions
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- Let it_manager edit locations too (fix typos/mistakes without needing
-- admin/manager) — the app route already checks this role; the RLS policy
-- from 00021_security_warnings_fix.sql also needs updating or the write
-- silently fails at the DB layer (PostgREST "Cannot coerce the result to a
-- single JSON object" — 0 rows matched the USING clause). DELETE stays
-- admin-only: deactivating a location affects billing/leads/bookings
-- company-wide, not just facility.
DROP POLICY IF EXISTS "Admin and manager can update locations" ON public.locations;

CREATE POLICY "Admin, manager and IT manager can update locations"
  ON public.locations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager')
        AND is_active = true
    )
  );

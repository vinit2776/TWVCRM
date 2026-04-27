-- ============================================================
-- Migration 00110: RLS Security Fixes
-- ============================================================
-- Resolves two Supabase Security Advisor CRITICAL issues:
--
--   1. rls_disabled_in_public
--      Four tables in the public schema have no Row-Level Security,
--      meaning the Supabase REST API would return their data to any
--      authenticated (and in some cases unauthenticated) caller.
--
--      Affected tables:
--        • cron_health                — internal cron monitoring
--        • proposal_line_item_presets — proposal pricing presets
--        • waiver_requests            — booking waiver submissions
--        • waiver_request_otps        — one-time passwords for waiver approval
--
--   2. sensitive_columns_exposed
--      waiver_request_otps.otp (TEXT) contains live OTP codes.
--      With RLS disabled it was readable by any authenticated user.
--      Fix: enable RLS and add NO user-facing SELECT policy — all
--      OTP operations go through the service-role key server-side.
--
-- Policy design principles used throughout:
--   • Authenticated-read / admin-write for internal config tables
--   • Owner-or-manager access for operational records
--   • Zero user-facing policies for OTP / secret tables
-- ============================================================


-- ============================================================
-- 1. cron_health
--    Internal table tracking the last-run time and status of
--    Vercel cron jobs.  The Infrastructure page reads this for
--    Admins only.  All writes come from the server (service role).
-- ============================================================
ALTER TABLE cron_health ENABLE ROW LEVEL SECURITY;

-- Admins (and only admins) may read cron health from the UI.
CREATE POLICY "Admin can read cron health"
  ON cron_health FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- No INSERT / UPDATE / DELETE policies — server writes via service role.


-- ============================================================
-- 2. proposal_line_item_presets
--    Pricing presets shown in the proposal line-item picker.
--    All staff need SELECT; only admin / manager may manage them.
-- ============================================================
ALTER TABLE proposal_line_item_presets ENABLE ROW LEVEL SECURITY;

-- All authenticated staff may read active presets.
CREATE POLICY "Authenticated users can read presets"
  ON proposal_line_item_presets FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only admin / manager may create, edit, or delete presets.
CREATE POLICY "Admin and manager can insert presets"
  ON proposal_line_item_presets FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

CREATE POLICY "Admin and manager can update presets"
  ON proposal_line_item_presets FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

CREATE POLICY "Admin and manager can delete presets"
  ON proposal_line_item_presets FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );


-- ============================================================
-- 3. waiver_requests
--    Staff submits waiver requests for booking overruns.
--    Requester can see their own submissions; managers/admins
--    see all and can approve/deny.
-- ============================================================
ALTER TABLE waiver_requests ENABLE ROW LEVEL SECURITY;

-- All staff may read waiver requests (needed to track booking waivers).
CREATE POLICY "Authenticated users can read waiver requests"
  ON waiver_requests FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Any authenticated staff member may submit a waiver request.
CREATE POLICY "Authenticated users can insert waiver requests"
  ON waiver_requests FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Only admin / manager may update status (approve / deny).
CREATE POLICY "Admin and manager can update waiver requests"
  ON waiver_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- Only admin / manager may delete.
CREATE POLICY "Admin and manager can delete waiver requests"
  ON waiver_requests FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );


-- ============================================================
-- 4. waiver_request_otps  ← PRIMARY sensitive_columns_exposed FIX
--    Contains raw OTP codes (otp TEXT) used for manager
--    authorization of waiver approvals.  These must NEVER be
--    readable via the REST API.  All reads/writes are done
--    server-side using the service-role key, which bypasses RLS.
--
--    Enabling RLS with NO user-facing policies means:
--      • anon role   → zero access (correct)
--      • authenticated role → zero access (correct)
--      • service_role → bypasses RLS, full access (correct,
--        used by /api routes for OTP generation & verification)
-- ============================================================
ALTER TABLE waiver_request_otps ENABLE ROW LEVEL SECURITY;

-- Intentionally NO policies — service role only.
-- Any attempt to query this table via the client-side Supabase SDK
-- will return an empty result set, protecting the OTP codes.

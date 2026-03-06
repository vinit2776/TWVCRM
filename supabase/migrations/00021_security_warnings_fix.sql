-- ==========================================
-- Migration 00021: Security Warnings Fix
-- ==========================================
-- Addresses 3 of 46 Security Advisor warnings.
-- The remaining 43 warnings are intentional (see notes below).
--
-- FIXED:
--   1. function_search_path_mutable — generate_ticket_number()
--      Created for support_tickets but missing SET search_path = public.
--
--   2. admin_otp — RLS Policy Always True (ALL operations)
--      Any authenticated user could read every OTP in the table,
--      including OTPs requested by other users. Restricts SELECT/UPDATE
--      to the owner; INSERT kept open (server-side API populates it);
--      DELETE blocked from client (service-role key handles cleanup).
--
--   3. locations — RLS Policy Always True (INSERT/UPDATE/DELETE)
--      The /locations UI page is admin/manager-only, but the DB had no
--      enforcement. Any authenticated user could create or delete locations.
--      Fix: restrict mutations to admin/manager roles; keep SELECT open
--      (all staff need locations in dropdowns).
--
-- INTENTIONALLY IGNORED (43 warnings):
--   • pg_trgm Extension in Public — installed by Supabase in the public
--     schema; moving it requires dropping all GIN indexes and tsvector
--     columns. Not a real risk for an internal tool.
--   • RLS Policy Always True on Virtual-Office tables (aggregators,
--     aggregator_contacts, aggregator_invoices, aggregator_rate_cards,
--     cases, case_agreements, case_comments, case_compliance_checks,
--     case_documents, case_emails) — all staff legitimately need full
--     CRUD; {authenticated} role restriction is the security boundary.
--   • RLS Policy Always True on contracts, billing_statements,
--     usage_charges, voucher_issuances, voucher_repository — same
--     reasoning; internal CRM tables for all staff.
-- ==========================================


-- ==========================================
-- FIX 1: generate_ticket_number — add SET search_path = public
-- ==========================================
CREATE OR REPLACE FUNCTION public.generate_ticket_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(ticket_number FROM 'TWV-T-(\d+)') AS INTEGER)
  ), 0) + 1
    INTO next_num FROM public.support_tickets;
  NEW.ticket_number := 'TWV-T-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;


-- ==========================================
-- FIX 2: admin_otp — tighten overly-permissive ALL policy
-- ==========================================
-- Drop the blanket "any authenticated user can do everything" policy.
DROP POLICY IF EXISTS "Authenticated users can manage admin_otp" ON public.admin_otp;

-- INSERT: any authenticated user may request an OTP.
-- (The server-side API route /api/admin/otp already enforces business rules.)
CREATE POLICY "Authenticated users can create admin_otp"
  ON public.admin_otp FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- SELECT: users may only read their own OTP records.
-- (admin_otp.requested_by → public.users.id; join via auth_id to auth.uid())
CREATE POLICY "Users can view own admin_otp"
  ON public.admin_otp FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = admin_otp.requested_by
        AND auth_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );

-- UPDATE: only the owner or an admin may update (mark used, increment attempts).
-- The server /api/admin/otp (PUT) uses the service-role key so this is
-- defence-in-depth rather than the primary control.
CREATE POLICY "Users can update own admin_otp"
  ON public.admin_otp FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = admin_otp.requested_by
        AND auth_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );

-- DELETE: no client policy — only the service-role key (server) can delete.


-- ==========================================
-- FIX 3: locations — restrict mutations to admin/manager
-- ==========================================
-- Drop the blanket "any authenticated user can do everything" policy.
DROP POLICY IF EXISTS "Authenticated users can manage locations" ON public.locations;

-- SELECT stays open — all staff need locations in dropdowns across the app.
-- (The existing "Authenticated users can read locations" SELECT policy is kept.)

-- INSERT: admin and manager only.
CREATE POLICY "Admin and manager can insert locations"
  ON public.locations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- UPDATE: admin and manager only.
CREATE POLICY "Admin and manager can update locations"
  ON public.locations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- DELETE: admin only (hard delete is risky given many FK references).
CREATE POLICY "Admin can delete locations"
  ON public.locations FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );

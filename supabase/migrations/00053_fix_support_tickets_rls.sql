-- ==========================================
-- Migration 00053: Fix Support Tickets RLS
-- ==========================================
-- Fixes "new row violates row-level security policy for table 'support_tickets'"
-- error when any user submits a bug report via the Report an Issue dialog.
--
-- Root cause: The support_tickets table was created outside migrations so it
-- may lack explicit GRANT to the authenticated role. The INSERT RLS policy
-- also lacked an explicit TO authenticated clause.
-- ==========================================


-- 1. Grant table-level permissions to authenticated role
GRANT SELECT, INSERT ON public.support_tickets TO authenticated;
GRANT SELECT, INSERT ON public.support_ticket_notes TO authenticated;

-- Ensure service_role has full access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_tickets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_ticket_notes TO service_role;


-- 2. Recreate INSERT policy with explicit role targeting
DROP POLICY IF EXISTS "Authenticated users can create support tickets" ON public.support_tickets;
CREATE POLICY "Authenticated users can create support tickets"
  ON public.support_tickets FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Also fix the notes INSERT policy
DROP POLICY IF EXISTS "Authenticated users can create ticket notes" ON public.support_ticket_notes;
CREATE POLICY "Authenticated users can create ticket notes"
  ON public.support_ticket_notes FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Fix support_tickets SELECT RLS policy
-- The reported_by column stores users.id (internal UUID), not auth.uid().
-- The old policy compared reported_by = auth.uid() which never matched,
-- so non-admin users could never see their own tickets.

-- Also grant UPDATE to authenticated so ticket owners can reopen.
GRANT SELECT, INSERT, UPDATE ON public.support_tickets TO authenticated;

DROP POLICY IF EXISTS "Users can view own support tickets" ON public.support_tickets;
CREATE POLICY "Users can view own support tickets"
  ON public.support_tickets FOR SELECT
  TO authenticated
  USING (
    reported_by IN (
      SELECT id FROM public.users WHERE auth_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- Fix RLS policies on credit_note_uploads: 00406 copied the same bug already
-- fixed once for gst_invoice_uploads in 00263_fix_gst_invoice_uploads_rls.sql —
-- users.id is the internal PK, not the auth user id; the correct column to
-- match auth.uid() against is users.auth_id.

DROP POLICY IF EXISTS "credit_note_uploads_select_accounts_admin" ON credit_note_uploads;
DROP POLICY IF EXISTS "credit_note_uploads_insert_accounts_admin" ON credit_note_uploads;

CREATE POLICY "credit_note_uploads_select_accounts_admin"
  ON credit_note_uploads
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role IN ('accounts', 'admin', 'office_admin', 'manager')
    )
  );

CREATE POLICY "credit_note_uploads_insert_accounts_admin"
  ON credit_note_uploads
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role IN ('accounts', 'admin')
    )
  );

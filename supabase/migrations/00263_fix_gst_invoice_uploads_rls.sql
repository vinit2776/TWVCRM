-- Fix RLS policies on gst_invoice_uploads and tally_voucher_snapshots:
-- the original policies used users.id = auth.uid() but users.id is the
-- internal PK; the correct column is users.auth_id.
-- Also enable the tally_handoff_v2_enabled feature flag.

-- Drop the broken policies
DROP POLICY IF EXISTS "gst_uploads_select_accounts_admin" ON gst_invoice_uploads;
DROP POLICY IF EXISTS "gst_uploads_insert_accounts_admin" ON gst_invoice_uploads;
DROP POLICY IF EXISTS "gst_uploads_update_accounts_admin" ON gst_invoice_uploads;
DROP POLICY IF EXISTS "voucher_snapshots_select_accounts_admin" ON tally_voucher_snapshots;

-- Recreate with the correct auth_id column
CREATE POLICY "gst_uploads_select_accounts_admin"
  ON gst_invoice_uploads
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role IN ('accounts', 'admin', 'office_admin', 'manager')
    )
  );

CREATE POLICY "gst_uploads_insert_accounts_admin"
  ON gst_invoice_uploads
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role IN ('accounts', 'admin')
    )
  );

CREATE POLICY "gst_uploads_update_accounts_admin"
  ON gst_invoice_uploads
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role IN ('accounts', 'admin')
    )
  );

CREATE POLICY "voucher_snapshots_select_accounts_admin"
  ON tally_voucher_snapshots
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.auth_id = auth.uid()
        AND users.role IN ('accounts', 'admin', 'office_admin', 'manager')
    )
  );

-- Enable handoff v2 — the upload form is live
UPDATE app_settings SET value = 'true' WHERE key = 'tally_handoff_v2_enabled';

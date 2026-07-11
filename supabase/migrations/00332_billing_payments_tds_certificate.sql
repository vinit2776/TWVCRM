-- TDS Receivable: optional certificate attachment.
-- Accounts can attach the Form 16A / TDS certificate the client sends for a
-- given deduction, for future reference during 26AS reconciliation. Never
-- mandatory — the deduction itself is already recorded via tds_amount on the
-- payment (see 00243_billing_payments_tds.sql).
ALTER TABLE billing_payments
  ADD COLUMN IF NOT EXISTS tds_certificate_path text;

COMMENT ON COLUMN billing_payments.tds_certificate_path IS
  'Supabase Storage path (crm-documents bucket) for an optionally-uploaded TDS certificate covering this deduction. Null until accounts uploads one.';

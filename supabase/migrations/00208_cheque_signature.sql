-- 00195_cheque_signature.sql
-- Track cheque signature status on vendor bills.
-- When payment_mode = 'cheque', the vendor payment-confirmation email is
-- withheld until an authorised user marks the cheque as signed.

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS cheque_signed_at  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cheque_signed_by  UUID        DEFAULT NULL
    REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN vendor_bills.cheque_signed_at IS
  'Timestamp when the physical cheque was signed. NULL means unsigned (email blocked for cheque payments).';
COMMENT ON COLUMN vendor_bills.cheque_signed_by IS
  'User who confirmed the cheque was signed.';

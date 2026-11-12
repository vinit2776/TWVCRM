-- Rent Management writes status = 'approved' in three places: the admin Approve action,
-- manual payment creation under blanket approval, and the monthly generator cron. The
-- original CHECK (00177) never listed it, so every one of those writes was rejected.
--
-- Rollback: restore the original list. Only safe while no row has status = 'approved'.
--   ALTER TABLE lease_payments DROP CONSTRAINT lease_payments_status_check;
--   ALTER TABLE lease_payments ADD CONSTRAINT lease_payments_status_check
--     CHECK (status IN ('pending','paid','overdue','on_hold','disputed'));

ALTER TABLE lease_payments DROP CONSTRAINT IF EXISTS lease_payments_status_check;
ALTER TABLE lease_payments ADD CONSTRAINT lease_payments_status_check
  CHECK (status IN ('pending','approved','paid','overdue','on_hold','disputed'));

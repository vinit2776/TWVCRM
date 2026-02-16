-- Add validity_days column to voucher_repository
ALTER TABLE voucher_repository ADD COLUMN validity_days INTEGER;

-- Index for filtering by validity group
CREATE INDEX idx_voucher_validity_days ON voucher_repository (validity_days);

-- Composite index for inventory queries (available vouchers grouped by validity)
CREATE INDEX idx_voucher_status_validity ON voucher_repository (status, validity_days, uploaded_at);

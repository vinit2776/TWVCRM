-- Link usage_charges rows back to the contract_facilities row that was used
-- to calculate quota. Nullable because:
--   1. Historical rows pre-date this column.
--   2. Non-quota bookings (walk-ins, day-pass) never have a facility.
--   3. Service overage charges (B&W print) are not facility-based.

ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS contract_facility_id UUID
    REFERENCES contract_facilities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_usage_charges_facility
  ON usage_charges (contract_facility_id)
  WHERE contract_facility_id IS NOT NULL;

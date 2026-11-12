-- Print (service_usage_records) and facility (facility_usage_records) usage
-- rows had no way to be waived — only ad-hoc usage_charges could (waived_at/
-- waived_by/waive_reason). A print/facility overage that never gets caught
-- by generateUsageStatements' single-month window (e.g. the covering
-- statement already went out) sits in the Unbilled queue forever with
-- nothing to act on. Add the same waive columns here so both sources get
-- parity with manual charges.
ALTER TABLE service_usage_records
  ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waived_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS waive_reason TEXT;

ALTER TABLE facility_usage_records
  ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waived_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS waive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_service_usage_records_waived
  ON service_usage_records (waived_at) WHERE waived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_facility_usage_records_waived
  ON facility_usage_records (waived_at) WHERE waived_at IS NOT NULL;

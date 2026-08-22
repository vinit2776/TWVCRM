-- Snapshot of OneGrid meter readings captured at the moment a headcount
-- reading is logged, for locations with telemetry enabled. Captured
-- best-effort/async after the headcount row is saved — null means either
-- "this location has no meter" or "the capture failed/timed out", not
-- "zero consumption".
ALTER TABLE space_headcounts
  ADD COLUMN IF NOT EXISTS energy_reading_wh NUMERIC,
  ADD COLUMN IF NOT EXISTS energy_today_wh NUMERIC,
  ADD COLUMN IF NOT EXISTS energy_device_id TEXT,
  ADD COLUMN IF NOT EXISTS energy_captured_at TIMESTAMPTZ;

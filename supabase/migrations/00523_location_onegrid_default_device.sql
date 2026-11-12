-- Remembers which OneGrid meter a location's telemetry panel should default
-- to (a plant can have multiple registered devices/meters).
ALTER TABLE location_electricity_config
  ADD COLUMN IF NOT EXISTS onegrid_default_device_id TEXT;

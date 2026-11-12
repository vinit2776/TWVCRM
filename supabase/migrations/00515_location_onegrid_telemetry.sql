-- Per-location OneGrid telemetry API key, so each location can read its own
-- energy meters via the OneGrid Telemetry Data API (org-scoped key).
ALTER TABLE location_electricity_config
  ADD COLUMN IF NOT EXISTS onegrid_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS onegrid_api_key TEXT;

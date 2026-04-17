-- Add GPS coordinates to locations so the headcount page can
-- auto-select the nearest location using the browser's Geolocation API.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

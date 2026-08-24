-- Append-only ledger of OneGrid 15-minute energy buckets, independent of
-- OneGrid's own retention (which has already been observed to churn —
-- a device disappeared mid-week and history along with it).
--
-- Filled opportunistically off headcount saves rather than a cron: each
-- capture backfills from the last row already stored for that
-- location+device up to now, so density tracks actual usage instead of
-- running fixed-schedule polls against locations nobody is looking at.
CREATE TABLE IF NOT EXISTS location_energy_readings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id      UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  device_id        TEXT NOT NULL,
  ts               TIMESTAMPTZ NOT NULL,
  energy_delta_wh  NUMERIC,
  cumulative_wh    NUMERIC,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, device_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_location_energy_readings_lookup
  ON location_energy_readings (location_id, device_id, ts DESC);

ALTER TABLE location_energy_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "location_energy_readings_select_authenticated"
  ON location_energy_readings FOR SELECT
  TO authenticated
  USING (true);

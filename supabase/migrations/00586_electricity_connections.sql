-- Electricity connections (Phase 2, PR A)
--
-- Two additive changes. Nothing existing is modified or backfilled.
--
-- 1. procurement_vendors.is_electricity_provider — marks a vendor (utility or
--    landlord) whose bills must later be tied to a location. Default false, so
--    every existing vendor behaves exactly as before.
--
-- 2. location_electricity_connections — one row per utility connection at a
--    location. One utility vendor can serve many locations, and a bill's own
--    wording for the site is outside our control, so a connection is identified
--    by whichever of these the vendor prints: a consumer number and/or "remembered
--    names" (bill_aliases). Both are optional. A connection also records which
--    OneGrid meter measures it and its sanctioned demand, for reconciliation.
--
-- Uniqueness: an active consumer number belongs to exactly one connection per
-- vendor (compared ignoring case, spacing and punctuation). Deactivating a
-- connection frees its number. Remembered names are kept unique per vendor by the
-- API (an array column cannot carry a simple unique index).
--
-- Writes go through the API with an admin check (service role), so RLS grants
-- authenticated users SELECT only.
--
-- Rollback:
--   DROP TABLE IF EXISTS location_electricity_connections;
--   ALTER TABLE procurement_vendors DROP COLUMN IF EXISTS is_electricity_provider;

ALTER TABLE procurement_vendors
  ADD COLUMN IF NOT EXISTS is_electricity_provider BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS location_electricity_connections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  vendor_id          UUID NOT NULL REFERENCES procurement_vendors(id),

  -- As printed on the bill. Optional: landlord bills often carry none.
  consumer_number    TEXT,
  -- Comparison key: lower-cased, letters and digits only. Generated, so it can
  -- never drift from consumer_number and the unique index below always applies.
  consumer_number_key TEXT GENERATED ALWAYS AS (
    NULLIF(lower(regexp_replace(consumer_number, '[^a-zA-Z0-9]', '', 'g')), '')
  ) STORED,

  -- Wordings this vendor has used for the connection (tenant / site name on the bill).
  bill_aliases       TEXT[] NOT NULL DEFAULT '{}',

  meter_label        TEXT,                       -- e.g. "Main HT meter"
  onegrid_device_id  TEXT,                       -- the OneGrid meter that measures it; null = not tracked
  sanctioned_kva     NUMERIC(10,2) CHECK (sanctioned_kva IS NULL OR sanctioned_kva > 0),

  is_active          BOOLEAN NOT NULL DEFAULT true,

  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lec_connections_location ON location_electricity_connections(location_id);
CREATE INDEX IF NOT EXISTS idx_lec_connections_vendor   ON location_electricity_connections(vendor_id);

-- One active connection per vendor + consumer number.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lec_connections_vendor_consumer
  ON location_electricity_connections(vendor_id, consumer_number_key)
  WHERE consumer_number_key IS NOT NULL AND is_active;

CREATE TRIGGER update_location_electricity_connections_updated_at
  BEFORE UPDATE ON location_electricity_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE location_electricity_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read location_electricity_connections"
  ON location_electricity_connections FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT SELECT ON public.location_electricity_connections TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.location_electricity_connections TO service_role;

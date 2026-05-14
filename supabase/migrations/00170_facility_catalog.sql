-- Central catalogue of bookable facilities per location.
-- Used as a reference / defaults source when setting up contract_facilities.
-- Facilities are location-specific: a "Board Room" at Baner is a different
-- catalogue item than a "Board Room" at Viman Nagar.

CREATE TABLE facility_catalog (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  unit                 TEXT NOT NULL DEFAULT 'hr',   -- hr, hrs, day, etc.
  default_cost_per_unit NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, name)
);

CREATE INDEX idx_facility_catalog_location ON facility_catalog (location_id) WHERE is_active = true;

ALTER TABLE facility_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_facility_catalog"
  ON facility_catalog FOR SELECT TO authenticated USING (true);

CREATE POLICY "admin_manager_write_facility_catalog"
  ON facility_catalog FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role IN ('admin', 'manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role IN ('admin', 'manager')
    )
  );

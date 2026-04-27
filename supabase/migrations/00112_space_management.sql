-- ============================================================
-- 00112: Space Management
-- Adds location_floors, space_units, and contract_space_allocations
-- Purely additive — no existing tables are modified.
-- ============================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE space_unit_type AS ENUM (
    'hot_desk',
    'dedicated_desk',
    'private_cabin',
    'managed_office',
    'business_centre'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotently add 'business_centre' for DBs created from earlier 4-value enum
ALTER TYPE space_unit_type ADD VALUE IF NOT EXISTS 'business_centre';

DO $$ BEGIN
  CREATE TYPE space_allocation_status AS ENUM ('active', 'ended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Table: location_floors
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS location_floors (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id          UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name                 VARCHAR(255) NOT NULL,
  floor_number         INTEGER,                        -- -1=basement, 0=ground, 1,2...
  total_area_sqft      NUMERIC(10,2) NOT NULL DEFAULT 0,
  leasable_area_sqft   NUMERIC(10,2) NOT NULL DEFAULT 0,
  grid_cols            INTEGER NOT NULL DEFAULT 20
                         CHECK (grid_cols BETWEEN 10 AND 30),
  grid_rows            INTEGER NOT NULL DEFAULT 12
                         CHECK (grid_rows BETWEEN 8 AND 20),
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_floors_location ON location_floors(location_id);

DO $$ BEGIN
  CREATE TRIGGER update_location_floors_updated_at
    BEFORE UPDATE ON location_floors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE location_floors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "floors_select" ON location_floors;
DROP POLICY IF EXISTS "floors_insert" ON location_floors;
DROP POLICY IF EXISTS "floors_update" ON location_floors;
DROP POLICY IF EXISTS "floors_delete" ON location_floors;

CREATE POLICY "floors_select" ON location_floors
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "floors_insert" ON location_floors
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

CREATE POLICY "floors_update" ON location_floors
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

CREATE POLICY "floors_delete" ON location_floors
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- Table: space_units
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space_units (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id      UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  floor_id         UUID REFERENCES location_floors(id) ON DELETE SET NULL,
  name             VARCHAR(255) NOT NULL,       -- "Cabin 03"
  code             VARCHAR(20)  NOT NULL,       -- "C-03"
  type             space_unit_type NOT NULL,
  capacity         INTEGER NOT NULL DEFAULT 1,  -- seats
  area_sqft        NUMERIC(10,2),
  monthly_rate     NUMERIC(12,2),               -- nullable: business_centre is hourly-only
  daily_rate       NUMERIC(12,2),
  hourly_rate      NUMERIC(10,2),               -- primary rate for business_centre
  amenities        TEXT[] DEFAULT '{}',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  notes            TEXT,
  -- Grid position (1-indexed)
  grid_col         INTEGER NOT NULL DEFAULT 1,
  grid_row         INTEGER NOT NULL DEFAULT 1,
  grid_col_span    INTEGER NOT NULL DEFAULT 2,
  grid_row_span    INTEGER NOT NULL DEFAULT 2,
  color            VARCHAR(20),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Code only needs to be unique among ACTIVE units, so a soft-deleted
-- unit doesn't permanently block its code from being reused.
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_units_location_code_active
  ON space_units (location_id, code)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_space_units_location ON space_units(location_id);
CREATE INDEX IF NOT EXISTS idx_space_units_floor    ON space_units(floor_id);
CREATE INDEX IF NOT EXISTS idx_space_units_type     ON space_units(type);
CREATE INDEX IF NOT EXISTS idx_space_units_active   ON space_units(is_active);

DO $$ BEGIN
  CREATE TRIGGER update_space_units_updated_at
    BEFORE UPDATE ON space_units
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE space_units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "space_units_select" ON space_units;
DROP POLICY IF EXISTS "space_units_insert" ON space_units;
DROP POLICY IF EXISTS "space_units_update" ON space_units;
DROP POLICY IF EXISTS "space_units_delete" ON space_units;

CREATE POLICY "space_units_select" ON space_units
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "space_units_insert" ON space_units
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

CREATE POLICY "space_units_update" ON space_units
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

CREATE POLICY "space_units_delete" ON space_units
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- Table: contract_space_allocations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contract_space_allocations (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id    UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  space_unit_id  UUID NOT NULL REFERENCES space_units(id) ON DELETE CASCADE,
  allocated_at   TIMESTAMPTZ DEFAULT NOW(),
  start_date     DATE NOT NULL,
  end_date       DATE,
  status         space_allocation_status NOT NULL DEFAULT 'active',
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contract_id, space_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_csa_contract    ON contract_space_allocations(contract_id);
CREATE INDEX IF NOT EXISTS idx_csa_space_unit  ON contract_space_allocations(space_unit_id);
CREATE INDEX IF NOT EXISTS idx_csa_status      ON contract_space_allocations(status);

DO $$ BEGIN
  CREATE TRIGGER update_csa_updated_at
    BEFORE UPDATE ON contract_space_allocations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE contract_space_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "csa_select" ON contract_space_allocations;
DROP POLICY IF EXISTS "csa_insert" ON contract_space_allocations;
DROP POLICY IF EXISTS "csa_update" ON contract_space_allocations;
DROP POLICY IF EXISTS "csa_delete" ON contract_space_allocations;

CREATE POLICY "csa_select" ON contract_space_allocations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "csa_insert" ON contract_space_allocations
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "csa_update" ON contract_space_allocations
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "csa_delete" ON contract_space_allocations
  FOR DELETE TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT ALL ON location_floors            TO authenticated;
GRANT ALL ON space_units                TO authenticated;
GRANT ALL ON contract_space_allocations TO authenticated;

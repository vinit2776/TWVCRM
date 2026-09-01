-- ============================================================
-- Migration 00006: Multi-Location Support
-- Adds locations table and location_id FK to leads, proposals,
-- contracts, and voucher_repository.
-- ============================================================

-- 1. Create locations table
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  code VARCHAR(10) UNIQUE NOT NULL,
  address TEXT,
  city VARCHAR(255),
  state VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger for updated_at
CREATE TRIGGER update_locations_updated_at
  BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2. RLS policies (permissive — matches existing pattern)
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read locations"
  ON locations FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage locations"
  ON locations FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3. Seed a default location for legacy data assignment
INSERT INTO locations (id, name, code, address, city, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Default Center',
  'DEF',
  'To be assigned',
  'Chennai',
  true
);

-- 4. Add location_id FK to leads (alongside existing preferred_location VARCHAR)
ALTER TABLE leads ADD COLUMN location_id UUID REFERENCES locations(id) ON DELETE SET NULL;
CREATE INDEX idx_leads_location_id ON leads(location_id);

-- 5. Add location_id FK to proposals
ALTER TABLE proposals ADD COLUMN location_id UUID REFERENCES locations(id) ON DELETE SET NULL;
CREATE INDEX idx_proposals_location_id ON proposals(location_id);

-- 6. Add location_id FK to contracts
ALTER TABLE contracts ADD COLUMN location_id UUID REFERENCES locations(id) ON DELETE SET NULL;
CREATE INDEX idx_contracts_location_id ON contracts(location_id);

-- 7. Add location_id FK to voucher_repository
ALTER TABLE voucher_repository ADD COLUMN location_id UUID REFERENCES locations(id) ON DELETE SET NULL;
CREATE INDEX idx_voucher_repository_location_id ON voucher_repository(location_id);

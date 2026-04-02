-- Master services list per location
CREATE TABLE IF NOT EXISTS location_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  price_per_unit DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(location_id, name)
);

ALTER TABLE location_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read location_services"
  ON location_services FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert location_services"
  ON location_services FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update location_services"
  ON location_services FOR UPDATE USING (auth.uid() IS NOT NULL);

-- Seed default services for all active locations
INSERT INTO location_services (location_id, name, unit, price_per_unit)
SELECT l.id, s.name, s.unit, s.price
FROM locations l
CROSS JOIN (VALUES
  ('Complimentary Printouts', 'nos', 0),
  ('Conference Hall', 'hours', 500),
  ('Meeting Room', 'hours', 300),
  ('Parking', 'nos', 0),
  ('Mail Handling', 'nos', 0),
  ('Locker', 'nos', 0)
) AS s(name, unit, price)
WHERE l.is_active = true
ON CONFLICT (location_id, name) DO NOTHING;

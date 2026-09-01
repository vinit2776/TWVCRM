-- Migration: 00008_conference_room_bookings
-- Adds conference room / meeting room booking module:
-- spaces, space_facilities, bookings, booking_facilities tables,
-- floor_manager role, booking enums, and voucher issuance flexibility.

-- 1. Expand user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'floor_manager';

-- 2. Create spaces table
CREATE TABLE spaces (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  capacity INTEGER NOT NULL DEFAULT 1,
  hourly_rate DECIMAL(12,2) NOT NULL,
  description TEXT,
  operating_hours JSONB DEFAULT '{
    "monday":    {"open":"09:00","close":"19:00","is_open":true},
    "tuesday":   {"open":"09:00","close":"19:00","is_open":true},
    "wednesday": {"open":"09:00","close":"19:00","is_open":true},
    "thursday":  {"open":"09:00","close":"19:00","is_open":true},
    "friday":    {"open":"09:00","close":"19:00","is_open":true},
    "saturday":  {"open":"09:00","close":"14:00","is_open":true},
    "sunday":    {"open":"09:00","close":"14:00","is_open":false}
  }',
  max_advance_booking_days INTEGER DEFAULT 30,
  min_booking_minutes INTEGER DEFAULT 60,
  cancellation_policy TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_spaces_location ON spaces(location_id);
CREATE INDEX idx_spaces_active ON spaces(is_active);

CREATE TRIGGER update_spaces_updated_at
  BEFORE UPDATE ON spaces
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 3. Create space_facilities table
CREATE TABLE space_facilities (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  is_complimentary BOOLEAN DEFAULT true,
  charge_per_use DECIMAL(12,2) DEFAULT 0,
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(space_id, name)
);

CREATE INDEX idx_space_facilities_space ON space_facilities(space_id);

-- 4. Create booking enums
CREATE TYPE booking_status AS ENUM (
  'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'
);

CREATE TYPE booking_customer_type AS ENUM (
  'contract_holder', 'walk_in', 'guest'
);

CREATE TYPE booking_payment_status AS ENUM (
  'pending', 'paid', 'waived', 'posted_to_bill'
);

-- 5. Create bookings table
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  booking_number VARCHAR(50) UNIQUE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  duration_hours DECIMAL(4,1) NOT NULL,
  customer_type booking_customer_type NOT NULL,
  contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  guest_name VARCHAR(255),
  guest_email VARCHAR(255),
  guest_phone VARCHAR(20),
  guest_company VARCHAR(255),
  hourly_rate DECIMAL(12,2) NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL,
  payment_status booking_payment_status DEFAULT 'pending',
  payment_mode VARCHAR(50),
  payment_reference VARCHAR(255),
  status booking_status DEFAULT 'confirmed',
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  checked_in_by UUID REFERENCES users(id),
  checked_out_by UUID REFERENCES users(id),
  usage_charge_id UUID REFERENCES usage_charges(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bookings_space ON bookings(space_id);
CREATE INDEX idx_bookings_location ON bookings(location_id);
CREATE INDEX idx_bookings_date ON bookings(booking_date);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_contract ON bookings(contract_id);
CREATE INDEX idx_bookings_lead ON bookings(lead_id);

CREATE TRIGGER update_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 6. Auto-generated booking number: TWV-B-XXXX
CREATE OR REPLACE FUNCTION generate_booking_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(booking_number FROM 'TWV-B-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM bookings;
  NEW.booking_number := 'TWV-B-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_number
  BEFORE INSERT ON bookings
  FOR EACH ROW WHEN (NEW.booking_number IS NULL)
  EXECUTE FUNCTION generate_booking_number();

-- 7. Create booking_facilities junction table
CREATE TABLE booking_facilities (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  facility_name VARCHAR(255) NOT NULL,
  is_complimentary BOOLEAN DEFAULT true,
  charge DECIMAL(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_booking_facilities_booking ON booking_facilities(booking_id);

-- 8. Allow voucher issuances without a contract (for walk-in/guest bookings)
ALTER TABLE voucher_issuances ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE voucher_issuances ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_voucher_issuances_booking ON voucher_issuances(booking_id);

-- 9. RLS policies (permissive, matching existing pattern)
ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_facilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read" ON spaces FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON spaces FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON spaces FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON spaces FOR DELETE USING (auth.uid() IS NOT NULL);

CREATE POLICY "auth_read" ON space_facilities FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON space_facilities FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON space_facilities FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON space_facilities FOR DELETE USING (auth.uid() IS NOT NULL);

CREATE POLICY "auth_read" ON bookings FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON bookings FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON bookings FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON bookings FOR DELETE USING (auth.uid() IS NOT NULL);

CREATE POLICY "auth_read" ON booking_facilities FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON booking_facilities FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON booking_facilities FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON booking_facilities FOR DELETE USING (auth.uid() IS NOT NULL);

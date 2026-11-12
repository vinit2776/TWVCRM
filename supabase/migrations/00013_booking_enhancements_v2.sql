-- ==========================================
-- Migration 00013: Booking Enhancements V2
-- ==========================================
-- Adds:
-- 1. recurring_booking_series table (recurring booking patterns)
-- 2. booking_waitlist table (queue for unavailable slots)
-- 3. ALTER bookings (series, reschedule, tokens, no-show detection)
-- 4. ALTER spaces (no-show grace period)

-- ==========================================
-- Recurring Booking Series Table
-- ==========================================
CREATE TABLE IF NOT EXISTS recurring_booking_series (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_type VARCHAR(20) NOT NULL,
  contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  guest_name VARCHAR(255),
  guest_phone VARCHAR(20),
  guest_email VARCHAR(255),
  guest_company VARCHAR(255),
  booker_phone VARCHAR(20),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  duration_hours DECIMAL(4,1) NOT NULL,
  frequency VARCHAR(20) NOT NULL CHECK (frequency IN ('daily','weekly','biweekly','monthly')),
  day_of_week INTEGER CHECK (day_of_week >= 0 AND day_of_week <= 6),
  day_of_month INTEGER CHECK (day_of_month >= 1 AND day_of_month <= 31),
  series_start DATE NOT NULL,
  series_end DATE NOT NULL,
  facility_ids UUID[],
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recurring_series_space ON recurring_booking_series(space_id);
CREATE INDEX idx_recurring_series_contract ON recurring_booking_series(contract_id);
CREATE INDEX idx_recurring_series_active ON recurring_booking_series(is_active);

CREATE TRIGGER update_recurring_booking_series_updated_at
  BEFORE UPDATE ON recurring_booking_series
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE recurring_booking_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read recurring series"
  ON recurring_booking_series FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert recurring series"
  ON recurring_booking_series FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update recurring series"
  ON recurring_booking_series FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete recurring series"
  ON recurring_booking_series FOR DELETE
  USING (auth.uid() IS NOT NULL);

-- ==========================================
-- Booking Waitlist Table
-- ==========================================
CREATE TABLE IF NOT EXISTS booking_waitlist (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  customer_type VARCHAR(20) NOT NULL,
  contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  guest_name VARCHAR(255),
  guest_phone VARCHAR(20),
  booker_phone VARCHAR(20),
  status VARCHAR(20) DEFAULT 'waiting' CHECK (status IN ('waiting','offered','booked','expired','cancelled')),
  notified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_waitlist_space ON booking_waitlist(space_id);
CREATE INDEX idx_waitlist_date ON booking_waitlist(booking_date);
CREATE INDEX idx_waitlist_status ON booking_waitlist(status);

CREATE TRIGGER update_booking_waitlist_updated_at
  BEFORE UPDATE ON booking_waitlist
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE booking_waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read waitlist"
  ON booking_waitlist FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert waitlist"
  ON booking_waitlist FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update waitlist"
  ON booking_waitlist FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete waitlist"
  ON booking_waitlist FOR DELETE
  USING (auth.uid() IS NOT NULL);

-- ==========================================
-- ALTER bookings: recurring, reschedule, tokens, no-show
-- ==========================================
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS series_id UUID REFERENCES recurring_booking_series(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rescheduled_from_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reschedule_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS original_booking_date DATE,
  ADD COLUMN IF NOT EXISTS original_start_time TIME,
  ADD COLUMN IF NOT EXISTS original_end_time TIME,
  ADD COLUMN IF NOT EXISTS feedback_token UUID DEFAULT extensions.uuid_generate_v4(),
  ADD COLUMN IF NOT EXISTS payment_token UUID DEFAULT extensions.uuid_generate_v4(),
  ADD COLUMN IF NOT EXISTS no_show_detected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bookings_series ON bookings(series_id);
CREATE INDEX IF NOT EXISTS idx_bookings_feedback_token ON bookings(feedback_token);
CREATE INDEX IF NOT EXISTS idx_bookings_payment_token ON bookings(payment_token);

-- ==========================================
-- ALTER spaces: no-show grace period
-- ==========================================
ALTER TABLE spaces
  ADD COLUMN IF NOT EXISTS no_show_grace_minutes INTEGER DEFAULT 15;

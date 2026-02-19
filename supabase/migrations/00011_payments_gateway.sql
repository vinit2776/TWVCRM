-- ==========================================
-- Migration 00011: Payment System & Gateway
-- ==========================================
-- Adds:
-- 1. app_settings table (key-value store for Razorpay config, UPI settings)
-- 2. booking_payments table (multi-payment per booking with screenshot support)

-- ==========================================
-- App Settings Table
-- ==========================================
CREATE TABLE IF NOT EXISTS app_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_encrypted BOOLEAN DEFAULT false,
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read settings"
  ON app_settings FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert settings"
  ON app_settings FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update settings"
  ON app_settings FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- Seed default settings
INSERT INTO app_settings (key, value) VALUES
  ('razorpay_key_id', ''),
  ('razorpay_key_secret', ''),
  ('razorpay_webhook_secret', ''),
  ('razorpay_enabled', 'false'),
  ('upi_id', ''),
  ('upi_qr_code_path', '')
ON CONFLICT (key) DO NOTHING;

-- ==========================================
-- Booking Payments Table (multi-payment per booking)
-- ==========================================
CREATE TABLE IF NOT EXISTS booking_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_mode VARCHAR(50) NOT NULL,
  payment_reference VARCHAR(255),
  screenshot_path VARCHAR(500),
  screenshot_verified BOOLEAN DEFAULT NULL,
  verification_notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  razorpay_order_id VARCHAR(255),
  razorpay_payment_id VARCHAR(255),
  razorpay_signature VARCHAR(500),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_booking_payments_booking ON booking_payments(booking_id);
CREATE INDEX idx_booking_payments_status ON booking_payments(status);
CREATE INDEX idx_booking_payments_razorpay ON booking_payments(razorpay_order_id);

CREATE TRIGGER update_booking_payments_updated_at
  BEFORE UPDATE ON booking_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE booking_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read payments"
  ON booking_payments FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert payments"
  ON booking_payments FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update payments"
  ON booking_payments FOR UPDATE
  USING (auth.uid() IS NOT NULL);

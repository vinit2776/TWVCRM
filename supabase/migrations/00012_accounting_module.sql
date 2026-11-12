-- ==========================================
-- Migration 00012: Accounting Module
-- ==========================================
-- Adds:
-- 1. contract_facilities table (per-contract facility definitions with free quotas)
-- 2. accounting_periods table (monthly period tracking with lock mechanism)
-- 3. facility_usage_records table (monthly usage per contract per facility)
-- 4. contract_payments table (payments against contract billing with cash handover tracking)
-- 5. ALTER billing_statements (add accounting period link + GST invoice fields)
-- 6. ALTER booking_payments (add cash handover tracking fields)

-- ==========================================
-- New Enums
-- ==========================================
CREATE TYPE accounting_period_status AS ENUM ('open', 'locked');
CREATE TYPE cash_handover_status AS ENUM ('pending_handover', 'handed_over');
CREATE TYPE contract_payment_mode AS ENUM ('cash', 'upi', 'card', 'bank_transfer', 'razorpay');
CREATE TYPE contract_payment_status AS ENUM ('pending', 'verified', 'rejected');

-- ==========================================
-- Contract Facilities Table
-- ==========================================
CREATE TABLE IF NOT EXISTS contract_facilities (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(100) NOT NULL,
  cost_per_unit DECIMAL(12,2) NOT NULL DEFAULT 0,
  free_quota DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contract_id, name)
);

CREATE INDEX idx_contract_facilities_contract ON contract_facilities(contract_id);
CREATE INDEX idx_contract_facilities_name ON contract_facilities(name);

CREATE TRIGGER update_contract_facilities_updated_at
  BEFORE UPDATE ON contract_facilities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE contract_facilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read contract facilities"
  ON contract_facilities FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert contract facilities"
  ON contract_facilities FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update contract facilities"
  ON contract_facilities FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete contract facilities"
  ON contract_facilities FOR DELETE
  USING (auth.uid() IS NOT NULL);

-- ==========================================
-- Accounting Periods Table
-- ==========================================
CREATE TABLE IF NOT EXISTS accounting_periods (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  status accounting_period_status DEFAULT 'open',
  locked_at TIMESTAMPTZ,
  locked_by UUID REFERENCES users(id),
  unlocked_at TIMESTAMPTZ,
  unlocked_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(year, month)
);

CREATE TRIGGER update_accounting_periods_updated_at
  BEFORE UPDATE ON accounting_periods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read accounting periods"
  ON accounting_periods FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert accounting periods"
  ON accounting_periods FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update accounting periods"
  ON accounting_periods FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- ==========================================
-- Facility Usage Records Table
-- ==========================================
CREATE TABLE IF NOT EXISTS facility_usage_records (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  accounting_period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  contract_facility_id UUID NOT NULL REFERENCES contract_facilities(id) ON DELETE RESTRICT,
  quantity_used DECIMAL(10,2) NOT NULL DEFAULT 0,
  free_quota_applied DECIMAL(10,2) NOT NULL DEFAULT 0,
  billable_quantity DECIMAL(10,2) NOT NULL DEFAULT 0,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(accounting_period_id, contract_id, contract_facility_id)
);

CREATE INDEX idx_facility_usage_period ON facility_usage_records(accounting_period_id);
CREATE INDEX idx_facility_usage_contract ON facility_usage_records(contract_id);
CREATE INDEX idx_facility_usage_facility ON facility_usage_records(contract_facility_id);

CREATE TRIGGER update_facility_usage_records_updated_at
  BEFORE UPDATE ON facility_usage_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE facility_usage_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read facility usage records"
  ON facility_usage_records FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert facility usage records"
  ON facility_usage_records FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update facility usage records"
  ON facility_usage_records FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete facility usage records"
  ON facility_usage_records FOR DELETE
  USING (auth.uid() IS NOT NULL);

-- ==========================================
-- Contract Payments Table
-- ==========================================
CREATE TABLE IF NOT EXISTS contract_payments (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  payment_number VARCHAR(50) UNIQUE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  accounting_period_id UUID REFERENCES accounting_periods(id) ON DELETE SET NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_mode contract_payment_mode NOT NULL,
  payment_reference VARCHAR(255),
  screenshot_path VARCHAR(500),
  screenshot_verified BOOLEAN DEFAULT NULL,
  status contract_payment_status DEFAULT 'pending',
  payment_date DATE NOT NULL,
  -- GST Invoice fields
  gst_invoice_number VARCHAR(100),
  gst_invoice_path VARCHAR(500),
  gst_invoice_status VARCHAR(20) DEFAULT NULL,
  gst_invoice_sent_at TIMESTAMPTZ,
  gst_invoice_sent_to TEXT,
  -- Payment reminder
  reminder_sent_at TIMESTAMPTZ,
  -- Cash handover tracking
  cash_handover_status cash_handover_status,
  collected_by UUID REFERENCES users(id),
  collected_at TIMESTAMPTZ,
  handed_over_to UUID REFERENCES users(id),
  handed_over_at TIMESTAMPTZ,
  handover_confirmed_by UUID REFERENCES users(id),
  handover_confirmed_at TIMESTAMPTZ,
  handover_notes TEXT,
  -- Standard fields
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contract_payments_contract ON contract_payments(contract_id);
CREATE INDEX idx_contract_payments_period ON contract_payments(accounting_period_id);
CREATE INDEX idx_contract_payments_status ON contract_payments(status);
CREATE INDEX idx_contract_payments_cash_handover ON contract_payments(cash_handover_status);
CREATE INDEX idx_contract_payments_date ON contract_payments(payment_date);

CREATE TRIGGER update_contract_payments_updated_at
  BEFORE UPDATE ON contract_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-generated payment number: TWV-CP-XXXX
CREATE OR REPLACE FUNCTION generate_contract_payment_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(payment_number FROM 'TWV-CP-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM contract_payments;
  NEW.payment_number := 'TWV-CP-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contract_payments_number
  BEFORE INSERT ON contract_payments
  FOR EACH ROW WHEN (NEW.payment_number IS NULL)
  EXECUTE FUNCTION generate_contract_payment_number();

ALTER TABLE contract_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read contract payments"
  ON contract_payments FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert contract payments"
  ON contract_payments FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update contract payments"
  ON contract_payments FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- ==========================================
-- ALTER billing_statements
-- ==========================================
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS accounting_period_id UUID REFERENCES accounting_periods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gst_invoice_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS gst_invoice_path VARCHAR(500),
  ADD COLUMN IF NOT EXISTS gst_invoice_status VARCHAR(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gst_invoice_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gst_invoice_sent_to TEXT,
  ADD COLUMN IF NOT EXISTS payment_reminder_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_billing_statements_accounting_period ON billing_statements(accounting_period_id);

-- ==========================================
-- ALTER booking_payments (add cash handover tracking)
-- ==========================================
ALTER TABLE booking_payments
  ADD COLUMN IF NOT EXISTS cash_handover_status VARCHAR(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS collected_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handed_over_to UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handover_confirmed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS handover_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handover_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_booking_payments_cash_handover ON booking_payments(cash_handover_status);

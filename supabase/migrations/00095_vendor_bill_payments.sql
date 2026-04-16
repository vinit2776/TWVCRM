-- ============================================================
-- Migration 00095: Vendor bill payment history + partial approval
-- ============================================================

-- 1. Add partial-approval fields to vendor_bills
ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS approved_amount     NUMERIC(12,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS approved_amount_note TEXT          DEFAULT NULL;

-- 2. Backfill: approved bills without an approved_amount → set to total_amount
UPDATE vendor_bills
  SET approved_amount = total_amount
  WHERE approval_status = 'approved'
    AND approved_amount IS NULL;

-- 3. Create vendor_bill_payments table (payment history per bill)
CREATE TABLE IF NOT EXISTS vendor_bill_payments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id           UUID        NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_mode      TEXT        NOT NULL,
  payment_reference TEXT        DEFAULT NULL,
  payment_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
  notes             TEXT        DEFAULT NULL,
  recorded_by       UUID        NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Index for quick lookup by bill
CREATE INDEX IF NOT EXISTS idx_vendor_bill_payments_bill_id
  ON vendor_bill_payments(bill_id);

-- 5. RLS
ALTER TABLE vendor_bill_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read bill payments"
  ON vendor_bill_payments FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert bill payments"
  ON vendor_bill_payments FOR INSERT
  TO authenticated WITH CHECK (true);

-- ============================================================
-- Migration 00158: TDS Module Phase 1
-- Creates: tds_sections (lookup), vendor_bill_tds (deductions)
-- ============================================================

-- ── 1. TDS sections lookup ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tds_sections (
  code             TEXT        PRIMARY KEY,
  description      TEXT        NOT NULL,
  rate_individual  NUMERIC(5,2) NOT NULL,
  rate_company     NUMERIC(5,2) NOT NULL,
  rate_min         NUMERIC(5,2) NOT NULL,
  rate_max         NUMERIC(5,2) NOT NULL
);

INSERT INTO tds_sections (code, description, rate_individual, rate_company, rate_min, rate_max) VALUES
  ('194C',   'Contractors & Sub-contractors',  1.00,  2.00, 1.00,  2.00),
  ('194J_a', 'Technical Services',             2.00,  2.00, 2.00,  2.00),
  ('194J_b', 'Professional Services',         10.00, 10.00, 2.00, 10.00),
  ('194I_a', 'Rent – Plant & Machinery',       2.00,  2.00, 2.00,  2.00),
  ('194I_b', 'Rent – Land / Building',        10.00, 10.00,10.00, 10.00),
  ('194H',   'Commission & Brokerage',         5.00,  5.00, 5.00,  5.00)
ON CONFLICT (code) DO NOTHING;

-- ── 2. TDS deduction per payment instalment ───────────────────
CREATE TABLE IF NOT EXISTS vendor_bill_tds (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id       UUID        NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  payment_id    UUID        REFERENCES vendor_bill_payments(id) ON DELETE SET NULL,
  section_code  TEXT        NOT NULL REFERENCES tds_sections(code),
  vendor_type   TEXT        NOT NULL DEFAULT 'company'
                            CHECK (vendor_type IN ('individual', 'huf', 'company')),
  base_amount   NUMERIC(12,2) NOT NULL CHECK (base_amount > 0),
  tds_rate      NUMERIC(5,2)  NOT NULL CHECK (tds_rate > 0),
  tds_amount    NUMERIC(12,2) NOT NULL CHECK (tds_amount > 0),
  pan_available BOOLEAN     NOT NULL DEFAULT true,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'deposited')),
  challan_id    UUID        DEFAULT NULL,  -- FK added in migration 00159
  period_month  INT         NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year   INT         NOT NULL CHECK (period_year >= 2020),
  created_by    UUID        NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vbt_bill       ON vendor_bill_tds(bill_id);
CREATE INDEX IF NOT EXISTS idx_vbt_status     ON vendor_bill_tds(status);
CREATE INDEX IF NOT EXISTS idx_vbt_period     ON vendor_bill_tds(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_vbt_section    ON vendor_bill_tds(section_code);
CREATE INDEX IF NOT EXISTS idx_vbt_challan    ON vendor_bill_tds(challan_id);

ALTER TABLE vendor_bill_tds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read vendor_bill_tds"
  ON vendor_bill_tds FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert vendor_bill_tds"
  ON vendor_bill_tds FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update vendor_bill_tds"
  ON vendor_bill_tds FOR UPDATE TO authenticated USING (true);

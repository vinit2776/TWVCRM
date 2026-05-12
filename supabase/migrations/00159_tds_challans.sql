-- ============================================================
-- Migration 00159: TDS Challans + FK wiring + TAN seed
-- ============================================================

-- ── 1. ITNS 281 challan register ─────────────────────────────
CREATE TABLE IF NOT EXISTS tds_challans (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_ref     TEXT        UNIQUE NOT NULL,  -- e.g. TDSC-2605-001
  bsr_code        VARCHAR(7)  NOT NULL,
  challan_serial  VARCHAR(10) NOT NULL,
  deposit_date    DATE        NOT NULL,
  period_month    INT         NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year     INT         NOT NULL CHECK (period_year >= 2020),
  section_code    TEXT        NOT NULL REFERENCES tds_sections(code),
  total_amount    NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
  receipt_url     TEXT        DEFAULT NULL,
  notes           TEXT        DEFAULT NULL,
  deposited_by    UUID        NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tds_challans_period
  ON tds_challans(period_year, period_month);

CREATE INDEX IF NOT EXISTS idx_tds_challans_section
  ON tds_challans(section_code);

ALTER TABLE tds_challans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read tds_challans"
  ON tds_challans FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert tds_challans"
  ON tds_challans FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update tds_challans"
  ON tds_challans FOR UPDATE TO authenticated USING (true);

-- ── 2. Wire FK from vendor_bill_tds → tds_challans ───────────
ALTER TABLE vendor_bill_tds
  ADD CONSTRAINT fk_vbt_challan
  FOREIGN KEY (challan_id) REFERENCES tds_challans(id) ON DELETE SET NULL;

-- ── 3. Seed TDS org settings into app_settings ───────────────
INSERT INTO app_settings (key, value) VALUES
  ('tds_tan_number',    'CHEU00102E'),
  ('tds_entity_name',   'Sree Design Infrastructure Pvt Ltd'),
  ('tds_entity_pan',    '')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Electricity Sub-Billing Module: schema foundation
-- PR: feat/eb-schema
--
-- Changes that are NOT purely additive (require attention on rollback):
--   1. billing_statements.statement_type CHECK is dropped and recreated to add
--      'electricity'. This is a metadata-only ALTER (zero-downtime) but the
--      old constraint name must be restored on rollback.
--   2. A partial UNIQUE index is added to billing_statements. Pre-check prod
--      for violations before applying:
--        SELECT contract_id, period_start, statement_type, COUNT(*)
--        FROM billing_statements
--        WHERE status != 'voided'
--        GROUP BY contract_id, period_start, statement_type
--        HAVING COUNT(*) > 1;
--
-- Rollback SQL (run in reverse order):
--   DROP INDEX IF EXISTS idx_bs_contract_period_type_unique;
--   ALTER TABLE billing_statements DROP CONSTRAINT IF EXISTS billing_statements_statement_type_check;
--   ALTER TABLE billing_statements ADD CONSTRAINT billing_statements_statement_type_check
--     CHECK (statement_type IN ('combined', 'rent', 'usage'));
--   DROP INDEX IF EXISTS idx_eb_bills_location_month_unique;
--   ALTER TABLE vendor_bills DROP COLUMN IF EXISTS electricity_bill_id;
--   ALTER TABLE contracts DROP COLUMN IF EXISTS electricity_settings;
--   DROP TABLE IF EXISTS electricity_bill_lines;
--   DROP TABLE IF EXISTS electricity_bills;
--   DROP TABLE IF EXISTS location_electricity_config;

-- ============================================================
-- 1. location_electricity_config
-- ============================================================

CREATE TABLE IF NOT EXISTS location_electricity_config (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id                 UUID NOT NULL UNIQUE REFERENCES locations(id) ON DELETE CASCADE,

  -- Master switch
  enabled                     BOOLEAN NOT NULL DEFAULT false,
  -- When true: bill maps to contract, customer invoice generated, maker-checker review
  -- When false: vendor bill only, no customer statement, contract_id nullable
  reimbursement_enabled       BOOLEAN NOT NULL DEFAULT true,

  -- Landlord side
  landlord_vendor_id          UUID REFERENCES procurement_vendors(id),
  landlord_utility_pct        NUMERIC(5,2) NOT NULL DEFAULT 90
                                CHECK (landlord_utility_pct >= 0 AND landlord_utility_pct <= 100),
  landlord_generator_pct      NUMERIC(5,2) NOT NULL DEFAULT 10
                                CHECK (landlord_generator_pct >= 0 AND landlord_generator_pct <= 100),
  -- landlord_utility_pct + landlord_generator_pct must = 100 (enforced in app layer)
  landlord_generator_rate     NUMERIC(10,2) NOT NULL DEFAULT 0
                                CHECK (landlord_generator_rate >= 0),
  bill_due_day_of_month       INTEGER NOT NULL DEFAULT 15
                                CHECK (bill_due_day_of_month BETWEEN 1 AND 28),

  -- Landlord payable-side tax (for auto-created vendor bill)
  landlord_gst_applicable     BOOLEAN NOT NULL DEFAULT false,
  landlord_gst_rate           NUMERIC(5,2) DEFAULT 18
                                CHECK (landlord_gst_rate IS NULL OR landlord_gst_rate >= 0),
  tds_section                 TEXT,
  tds_rate                    NUMERIC(5,2) CHECK (tds_rate IS NULL OR tds_rate >= 0),

  -- Customer-side defaults (contract overrides these)
  customer_utility_pct        NUMERIC(5,2) NOT NULL DEFAULT 80
                                CHECK (customer_utility_pct >= 0 AND customer_utility_pct <= 100),
  customer_generator_pct      NUMERIC(5,2) NOT NULL DEFAULT 20
                                CHECK (customer_generator_pct >= 0 AND customer_generator_pct <= 100),
  -- customer_utility_pct + customer_generator_pct must = 100 (enforced in app layer)
  markup_type                 TEXT NOT NULL DEFAULT 'per_unit'
                                CHECK (markup_type IN ('per_unit', 'percent')),
  markup_value                NUMERIC(10,4) NOT NULL DEFAULT 0
                                CHECK (markup_value >= 0),
  customer_generator_rate     NUMERIC(10,2) NOT NULL DEFAULT 0
                                CHECK (customer_generator_rate >= 0),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lec_location ON location_electricity_config(location_id);

CREATE TRIGGER update_location_electricity_config_updated_at
  BEFORE UPDATE ON location_electricity_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE location_electricity_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read location_electricity_config"
  ON location_electricity_config FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert location_electricity_config"
  ON location_electricity_config FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update location_electricity_config"
  ON location_electricity_config FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ============================================================
-- 2. electricity_bills
-- ============================================================

CREATE TABLE IF NOT EXISTS electricity_bills (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id                 UUID NOT NULL REFERENCES locations(id),
  -- Nullable: null when reimbursement_enabled = false (vendor-bill-only path)
  contract_id                 UUID REFERENCES contracts(id),

  bill_month                  INTEGER NOT NULL CHECK (bill_month BETWEEN 1 AND 12),
  bill_year                   INTEGER NOT NULL CHECK (bill_year >= 2020),

  -- Landlord bill details
  landlord_bill_number        TEXT,
  landlord_bill_date          DATE,
  landlord_total_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  attachment_path             TEXT,

  -- Snapshot of config at capture time (reimbursement flag)
  reimbursement_enabled       BOOLEAN NOT NULL DEFAULT true,

  -- Snapshot of landlord splits at capture (for reproducibility)
  landlord_utility_pct        NUMERIC(5,2) NOT NULL,
  landlord_generator_pct      NUMERIC(5,2) NOT NULL,

  -- Customer-side computed snapshot (filled after compute, locked at confirm)
  customer_utility_pct        NUMERIC(5,2),
  customer_generator_pct      NUMERIC(5,2),
  customer_units_billed       NUMERIC(10,2),           -- override field (D5)
  customer_units_overridden   BOOLEAN NOT NULL DEFAULT false,
  customer_markup_type        TEXT CHECK (customer_markup_type IN ('per_unit', 'percent')),
  customer_markup_value       NUMERIC(10,4),
  customer_utility_rate       NUMERIC(10,4),           -- derived weighted-avg + markup
  customer_generator_rate     NUMERIC(10,2),
  customer_subtotal           NUMERIC(12,2),
  customer_cgst               NUMERIC(12,2),
  customer_sgst               NUMERIC(12,2),
  customer_total              NUMERIC(12,2),
  customer_round_off          NUMERIC(6,2),
  gst_rate                    NUMERIC(5,2) NOT NULL DEFAULT 18,  -- pinned per D3

  status                      TEXT NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'invoiced', 'revised')),

  -- Links created after respective events
  vendor_bill_id              UUID REFERENCES vendor_bills(id),
  billing_statement_id        UUID REFERENCES billing_statements(id),
  revised_from_id             UUID REFERENCES electricity_bills(id),  -- revision chain

  created_by                  UUID NOT NULL REFERENCES users(id),
  confirmed_by                UUID REFERENCES users(id),              -- maker-checker
  confirmed_at                TIMESTAMPTZ,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_eb_location     ON electricity_bills(location_id);
CREATE INDEX idx_eb_contract     ON electricity_bills(contract_id);
CREATE INDEX idx_eb_month_year   ON electricity_bills(bill_year, bill_month);
CREATE INDEX idx_eb_status       ON electricity_bills(status);
CREATE INDEX idx_eb_created      ON electricity_bills(created_at DESC);

-- Partial unique: one active bill per location+month (excludes revised rows)
CREATE UNIQUE INDEX idx_eb_bills_location_month_unique
  ON electricity_bills(location_id, bill_month, bill_year)
  WHERE status != 'revised';

CREATE TRIGGER update_electricity_bills_updated_at
  BEFORE UPDATE ON electricity_bills
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE electricity_bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read electricity_bills"
  ON electricity_bills FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert electricity_bills"
  ON electricity_bills FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update electricity_bills"
  ON electricity_bills FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ============================================================
-- 3. electricity_bill_lines
-- ============================================================

CREATE TABLE IF NOT EXISTS electricity_bill_lines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  electricity_bill_id   UUID NOT NULL REFERENCES electricity_bills(id) ON DELETE CASCADE,

  -- 'utility' and 'generator' have units+rate; 'other' has label+amount only
  line_type             TEXT NOT NULL CHECK (line_type IN ('utility', 'generator', 'other')),
  meter_label           TEXT,             -- e.g. "Main Meter", "Block B"
  units                 NUMERIC(10,2),    -- null for 'other' lines
  rate                  NUMERIC(10,4),    -- null for 'other' lines
  amount                NUMERIC(12,2) NOT NULL,
  label                 TEXT,             -- human label for 'other' lines

  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ebl_bill ON electricity_bill_lines(electricity_bill_id);

ALTER TABLE electricity_bill_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read electricity_bill_lines"
  ON electricity_bill_lines FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert electricity_bill_lines"
  ON electricity_bill_lines FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update electricity_bill_lines"
  ON electricity_bill_lines FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete electricity_bill_lines"
  ON electricity_bill_lines FOR DELETE USING (auth.uid() IS NOT NULL);

-- ============================================================
-- 4. contracts.electricity_settings JSONB
-- Stores overrides only; app falls back to location_electricity_config defaults.
-- Shape: { customer_utility_pct, customer_generator_pct, markup_type,
--          markup_value, customer_generator_rate, gst_rate }
-- ============================================================

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS electricity_settings JSONB;

-- ============================================================
-- 5. billing_statements.statement_type — add 'electricity'
-- Must DROP and recreate the CHECK constraint (not additive).
-- The constraint name from 00223 is the default Postgres-generated name.
-- ============================================================

ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_statement_type_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_statement_type_check
    CHECK (statement_type IN ('combined', 'rent', 'usage', 'electricity'));

-- ============================================================
-- 6. Partial unique index on billing_statements
-- Prevents duplicate active statements of the same type per contract+period.
-- Also closes the latent rent+usage double-generation race (00223 had a plain
-- index, not unique). REGRESSION: cron still creates rent+usage pairs because
-- they have distinct statement_type values.
-- Pre-check prod for violations (see header comment) before applying.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_bs_contract_period_type_unique
  ON billing_statements(contract_id, period_start, statement_type)
  WHERE status != 'voided';

-- ============================================================
-- 7. vendor_bills.electricity_bill_id — idempotency FK
-- Ensures compensate-and-retry can never double-create the payable.
-- ============================================================

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS electricity_bill_id UUID
    REFERENCES electricity_bills(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_bills_electricity_bill_unique
  ON vendor_bills(electricity_bill_id)
  WHERE electricity_bill_id IS NOT NULL;

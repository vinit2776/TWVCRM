-- ============================================================
-- 00118: Contract service quotas + print usage import scaffolding
--
-- Foundation for tracking quota-based services (printing, future:
-- meeting-room hours, coffee, guest passes) and billing the overage
-- on top of the fixed monthly contract charge.
--
-- Tables introduced:
--   service_catalog            — master list of quota-able services
--   contract_service_quotas    — per-contract entitlement (qty + rate)
--   proposal_service_quotas    — same shape, lives on proposals; copied
--                                onto contracts when proposals convert
--   service_usage_records      — per-customer-per-service-per-period
--                                tally; produces the line items that go
--                                onto the monthly billing statement
--   service_usage_imports      — audit history of uploaded usage reports
--                                (e.g. printer reports), one row per upload
--   location_print_templates   — per-location column-map for the
--                                print-server xlsx export. Format varies
--                                between locations, so we save a template
--                                per location instead of hard-coding one.
--
-- Plus:
--   contracts.department_id  — printer-side ID assigned to the customer.
--   Unique per location (partial index, NULLs allowed).
--
-- Storage bucket: service-imports — private, holds the uploaded xlsx
--                                  files and the sample/reference templates.
--
-- Purely additive — no existing rows or columns are changed.
-- ============================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE service_pricing_model AS ENUM ('per_unit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE service_usage_source AS ENUM ('printer_report', 'manual', 'meeting_booking', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE service_import_status AS ENUM ('preview', 'confirmed', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE service_import_source AS ENUM ('printer_report');  -- extensible later
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE print_template_quota_format AS ENUM ('used_slash_quota', 'used_only');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Table: service_catalog
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_catalog (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  VARCHAR(60) NOT NULL UNIQUE,
  name                  VARCHAR(120) NOT NULL,
  description           TEXT,
  unit_label            VARCHAR(40) NOT NULL,                  -- "per page", "per hour"
  pricing_model         service_pricing_model NOT NULL DEFAULT 'per_unit',
  default_overage_rate  NUMERIC(12,2) NOT NULL DEFAULT 0,      -- ex-GST
  gst_rate              NUMERIC(5,2) NOT NULL DEFAULT 18,
  -- Used by the importer to know which catalog row a column maps to
  -- (so we don't have to hardcode UUIDs in code).
  printer_column        VARCHAR(20),                            -- 'bw' | 'colour' | NULL
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_catalog_active ON service_catalog(is_active);

DO $$ BEGIN
  CREATE TRIGGER update_service_catalog_updated_at
    BEFORE UPDATE ON service_catalog
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE service_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_catalog_select" ON service_catalog;
DROP POLICY IF EXISTS "service_catalog_write"  ON service_catalog;
CREATE POLICY "service_catalog_select" ON service_catalog FOR SELECT TO authenticated USING (true);
CREATE POLICY "service_catalog_write"  ON service_catalog FOR ALL    TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true
    )
  );

-- Seed: B&W and Colour print
INSERT INTO service_catalog (slug, name, description, unit_label, default_overage_rate, gst_rate, printer_column, sort_order)
VALUES
  ('print-bw',     'B&W Print',    'Black & white printing / copying. Scans not charged.',  'per page',  5,  18, 'bw',     10),
  ('print-colour', 'Colour Print', 'Colour printing / copying. Scans not charged.',         'per page',  20, 18, 'colour', 20)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Table: contract_service_quotas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contract_service_quotas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  service_id      UUID NOT NULL REFERENCES service_catalog(id) ON DELETE RESTRICT,
  -- 0 = "no free quota; charge from the first unit"
  -- N = "first N units free per month, beyond charged at overage_rate"
  monthly_quota   NUMERIC(10,2) NOT NULL DEFAULT 0,
  overage_rate    NUMERIC(12,2) NOT NULL DEFAULT 0,             -- ex-GST
  notes           TEXT,
  created_by      UUID REFERENCES public.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contract_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_csq_contract ON contract_service_quotas(contract_id);
CREATE INDEX IF NOT EXISTS idx_csq_service  ON contract_service_quotas(service_id);

DO $$ BEGIN
  CREATE TRIGGER update_csq_updated_at
    BEFORE UPDATE ON contract_service_quotas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE contract_service_quotas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "csq_select" ON contract_service_quotas;
DROP POLICY IF EXISTS "csq_write"  ON contract_service_quotas;
CREATE POLICY "csq_select" ON contract_service_quotas FOR SELECT TO authenticated USING (true);
CREATE POLICY "csq_write"  ON contract_service_quotas FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Table: proposal_service_quotas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS proposal_service_quotas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id     UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  service_id      UUID NOT NULL REFERENCES service_catalog(id) ON DELETE RESTRICT,
  monthly_quota   NUMERIC(10,2) NOT NULL DEFAULT 0,
  overage_rate    NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (proposal_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_psq_proposal ON proposal_service_quotas(proposal_id);

DO $$ BEGIN
  CREATE TRIGGER update_psq_updated_at
    BEFORE UPDATE ON proposal_service_quotas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE proposal_service_quotas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "psq_select" ON proposal_service_quotas;
DROP POLICY IF EXISTS "psq_write"  ON proposal_service_quotas;
CREATE POLICY "psq_select" ON proposal_service_quotas FOR SELECT TO authenticated USING (true);
CREATE POLICY "psq_write"  ON proposal_service_quotas FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Table: service_usage_records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_usage_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- nullable contract: unmapped department IDs from printer reports
  -- get recorded with NULL contract_id (audited as "internal use").
  contract_id              UUID REFERENCES contracts(id) ON DELETE CASCADE,
  service_id               UUID NOT NULL REFERENCES service_catalog(id) ON DELETE RESTRICT,
  location_id              UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  period_year              INTEGER NOT NULL,
  period_month             INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),

  quantity_used            NUMERIC(12,2) NOT NULL DEFAULT 0,    -- e.g. 196 pages
  quota_snapshot           NUMERIC(10,2) NOT NULL DEFAULT 0,    -- captured when recorded
  overage_rate_snapshot    NUMERIC(12,2) NOT NULL DEFAULT 0,    -- ex-GST, captured when recorded
  overage_quantity         NUMERIC(12,2) NOT NULL DEFAULT 0,    -- max(0, used - quota) OR full used if no quota
  amount                   NUMERIC(12,2) NOT NULL DEFAULT 0,    -- ex-GST: overage_quantity × overage_rate_snapshot
  gst_rate                 NUMERIC(5,2)  NOT NULL DEFAULT 18,
  gst_amount               NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_with_gst           NUMERIC(12,2) NOT NULL DEFAULT 0,

  source                   service_usage_source NOT NULL,
  source_ref               TEXT,                                -- import_id, booking_id, etc.
  -- Detail blob for printer reports: copy/print/scan splits, raw row text.
  -- Lets us audit what was extracted without re-uploading the file.
  detail                   JSONB DEFAULT '{}'::JSONB,

  billing_statement_id     UUID REFERENCES billing_statements(id) ON DELETE SET NULL,
  is_billed                BOOLEAN NOT NULL DEFAULT FALSE,

  notes                    TEXT,
  created_by               UUID REFERENCES public.users(id),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),

  -- Idempotency: a single source can only emit ONE record per
  -- (contract, service, period). Re-uploading replaces (caller voids old
  -- before inserting new).
  UNIQUE (contract_id, service_id, period_year, period_month, source)
);

CREATE INDEX IF NOT EXISTS idx_sur_contract  ON service_usage_records(contract_id);
CREATE INDEX IF NOT EXISTS idx_sur_service   ON service_usage_records(service_id);
CREATE INDEX IF NOT EXISTS idx_sur_location  ON service_usage_records(location_id);
CREATE INDEX IF NOT EXISTS idx_sur_period    ON service_usage_records(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_sur_billed    ON service_usage_records(is_billed);
CREATE INDEX IF NOT EXISTS idx_sur_source_ref ON service_usage_records(source_ref);

DO $$ BEGIN
  CREATE TRIGGER update_sur_updated_at
    BEFORE UPDATE ON service_usage_records
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE service_usage_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sur_select" ON service_usage_records;
DROP POLICY IF EXISTS "sur_write"  ON service_usage_records;
CREATE POLICY "sur_select" ON service_usage_records FOR SELECT TO authenticated USING (true);
CREATE POLICY "sur_write"  ON service_usage_records FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Table: service_usage_imports
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_usage_imports (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id             UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  source                  service_import_source NOT NULL DEFAULT 'printer_report',
  period_year             INTEGER NOT NULL,
  period_month            INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),

  filename                TEXT,
  file_path               TEXT,                                  -- storage path
  file_size_bytes         INTEGER,

  -- Aggregates captured at preview time (before confirm)
  total_rows              INTEGER NOT NULL DEFAULT 0,
  mapped_rows             INTEGER NOT NULL DEFAULT 0,
  unmapped_rows           INTEGER NOT NULL DEFAULT 0,
  total_overage_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,      -- ex-GST sum
  total_with_gst          NUMERIC(14,2) NOT NULL DEFAULT 0,

  status                  service_import_status NOT NULL DEFAULT 'preview',

  imported_by             UUID REFERENCES public.users(id),
  imported_at             TIMESTAMPTZ DEFAULT NOW(),
  confirmed_by            UUID REFERENCES public.users(id),
  confirmed_at            TIMESTAMPTZ,
  voided_by               UUID REFERENCES public.users(id),
  voided_at               TIMESTAMPTZ,
  voided_reason           TEXT,

  -- Snapshot of the parsed preview rows so we can re-display without
  -- re-parsing the file. Each row has dept_id, contract_id (if mapped),
  -- bw_used, bw_quota_report, bw_overage, colour_*, total, plus flags.
  preview_rows            JSONB DEFAULT '[]'::JSONB,
  notes                   TEXT,

  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sui_location_period ON service_usage_imports(location_id, period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_sui_status          ON service_usage_imports(status);
CREATE INDEX IF NOT EXISTS idx_sui_imported_at     ON service_usage_imports(imported_at DESC);

DO $$ BEGIN
  CREATE TRIGGER update_sui_updated_at
    BEFORE UPDATE ON service_usage_imports
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE service_usage_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sui_select" ON service_usage_imports;
DROP POLICY IF EXISTS "sui_write"  ON service_usage_imports;
CREATE POLICY "sui_select" ON service_usage_imports FOR SELECT TO authenticated USING (true);
CREATE POLICY "sui_write"  ON service_usage_imports FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager', 'accounts') AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager', 'accounts') AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- Table: location_print_templates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS location_print_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         UUID NOT NULL UNIQUE REFERENCES locations(id) ON DELETE CASCADE,

  -- How many leading rows to skip (header). data starts at data_start_row.
  header_rows         INTEGER NOT NULL DEFAULT 3,
  data_start_row      INTEGER NOT NULL DEFAULT 4,

  -- Excel column letters (case-insensitive) for each field.
  -- Required:
  dept_id_col         VARCHAR(4) NOT NULL,
  bw_total_col        VARCHAR(4),
  colour_total_col    VARCHAR(4),
  -- Optional breakdown:
  bw_copy_col         VARCHAR(4),
  bw_print_col        VARCHAR(4),
  bw_scan_col         VARCHAR(4),
  colour_copy_col     VARCHAR(4),
  colour_print_col    VARCHAR(4),
  colour_scan_col     VARCHAR(4),

  -- "60/60" vs just "60" — the printer servers vary
  quota_format        print_template_quota_format NOT NULL DEFAULT 'used_slash_quota',

  -- Department IDs to skip (system / catch-all printer accounts)
  ignore_dept_ids     TEXT[] DEFAULT '{}',

  -- Reference file the admin used to set up the template.
  -- Used by the setup UI to let admin re-test the parse against a known sample.
  sample_file_path    TEXT,
  sample_file_name    TEXT,

  notes               TEXT,
  created_by          UUID REFERENCES public.users(id),
  updated_by          UUID REFERENCES public.users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lpt_location ON location_print_templates(location_id);

DO $$ BEGIN
  CREATE TRIGGER update_lpt_updated_at
    BEFORE UPDATE ON location_print_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE location_print_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lpt_select" ON location_print_templates;
DROP POLICY IF EXISTS "lpt_write"  ON location_print_templates;
CREATE POLICY "lpt_select" ON location_print_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "lpt_write"  ON location_print_templates FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- contracts.department_id (printer-side ID, unique per location)
-- ---------------------------------------------------------------------------

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS department_id VARCHAR(40);

-- Partial unique index — multiple NULLs allowed; non-NULL must be unique
-- within the contract's location. No FK on location_id in the index itself
-- (Postgres limitation), so we rely on the API layer + trigger below.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contracts_dept_per_loc
  ON contracts(location_id, department_id)
  WHERE department_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contracts_department_id
  ON contracts(department_id) WHERE department_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Storage bucket: service-imports (private)
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'service-imports',
  'service-imports',
  FALSE,
  10485760,                                                      -- 10 MB
  ARRAY[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream',                                  -- some browsers
    'text/csv'
  ]
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can upload service imports'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can upload service imports"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'service-imports')
    $policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can view service imports'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can view service imports"
      ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'service-imports')
    $policy$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT ALL ON service_catalog              TO authenticated;
GRANT ALL ON contract_service_quotas      TO authenticated;
GRANT ALL ON proposal_service_quotas      TO authenticated;
GRANT ALL ON service_usage_records        TO authenticated;
GRANT ALL ON service_usage_imports        TO authenticated;
GRANT ALL ON location_print_templates     TO authenticated;

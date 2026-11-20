-- VO address watch (part 1: data model only).
--
-- After a Virtual Office case lapses we check public records (GST portal by
-- GSTIN, MCA registered office, our own signals) for our address and keep every
-- check as evidence. Nothing reads or writes these yet; the job that does is
-- gated by app_settings.vo_address_watch_mode, which ships as 'off'.
--
-- Also widens billing_statements.statement_type with 'vo_holdover' (monthly
-- proforma while the address is still in use). Latest prior definition is
-- 00400; the list below is that list plus the new value.
--
-- Rollback: DROP TABLE IF EXISTS vo_address_checks;
--           ALTER TABLE cases DROP COLUMN IF EXISTS address_status,
--             DROP COLUMN IF EXISTS address_released_at,
--             DROP COLUMN IF EXISTS address_release_reason;
--           DELETE FROM app_settings WHERE key IN ('vo_address_watch_mode',
--             'vo_holdover_uplift_pct', 'vo_holdover_step_pct',
--             'vo_holdover_period_months', 'vo_holdover_cap_pct');
--           -- and recreate billing_statements_statement_type_check from 00400
--           -- (without 'vo_holdover', after deleting any such rows).

CREATE TABLE IF NOT EXISTS vo_address_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Days since the lapse date when the check was made.
  day_offset INT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('gst_portal', 'mca', 'website', 'reception', 'manual')),
  result TEXT,
  verdict TEXT NOT NULL
    CHECK (verdict IN ('in_use', 'likely', 'inconclusive', 'clear')),
  evidence_ref TEXT,
  evidence_path TEXT,
  -- NULL = the system ran the check.
  checked_by UUID REFERENCES users(id),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vo_address_checks_case_checked
  ON vo_address_checks (case_id, checked_at);

ALTER TABLE vo_address_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vo_address_checks_select" ON vo_address_checks;
CREATE POLICY "vo_address_checks_select" ON vo_address_checks
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "vo_address_checks_service" ON vo_address_checks;
CREATE POLICY "vo_address_checks_service" ON vo_address_checks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE cases ADD COLUMN IF NOT EXISTS address_status TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS address_released_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS address_release_reason TEXT;

ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_address_status_check;
ALTER TABLE cases ADD CONSTRAINT cases_address_status_check
  CHECK (address_status IS NULL OR address_status IN ('in_use', 'watching', 'released'));

-- Holdover rate: start uplift, step added every period, ceiling (all percent).
INSERT INTO app_settings (key, value) VALUES
  ('vo_address_watch_mode', 'off'),
  ('vo_holdover_uplift_pct', '25'),
  ('vo_holdover_step_pct', '10'),
  ('vo_holdover_period_months', '3'),
  ('vo_holdover_cap_pct', '60')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE billing_statements DROP CONSTRAINT IF EXISTS billing_statements_statement_type_check;
ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_statement_type_check
  CHECK (statement_type IN (
    'combined', 'rent', 'usage', 'electricity', 'reimbursement', 'vo_renewal',
    'vo_case',
    'vo_aggregator_consolidated',
    'vo_holdover'
  ));

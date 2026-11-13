-- Virtual Office KYC two-step review.
--
-- Step 1: the preparer runs the automatic flags and records what they saw on the
-- government portals. Step 2: a manager signs off, acknowledging each warning with
-- a reason. Flags are advisory: they never block, they only have to be answered.
--
-- Everything is additive and nullable. Nothing reads these columns outside the new
-- /api/cases/[id]/kyc-review routes, so the waiver flow and the weekly KYC digest
-- behave exactly as before.
--
-- Full Aadhaar numbers are never stored. extracted_id_masked holds the masked form
-- only (see maskAadhaar in src/lib/vo-kyc-validators.ts).
--
-- Rollback:
--   DROP TABLE IF EXISTS case_kyc_portal_checks;
--   ALTER TABLE cases
--     DROP COLUMN IF EXISTS kyc_flags, DROP COLUMN IF EXISTS kyc_checks_run_at,
--     DROP COLUMN IF EXISTS kyc_checks_run_by, DROP COLUMN IF EXISTS kyc_signoff_acks,
--     DROP COLUMN IF EXISTS kyc_reviewed_at, DROP COLUMN IF EXISTS kyc_reviewed_by;
--   ALTER TABLE case_documents
--     DROP COLUMN IF EXISTS auto_flags, DROP COLUMN IF EXISTS extracted_name,
--     DROP COLUMN IF EXISTS extracted_id_masked, DROP COLUMN IF EXISTS extracted_issued_on;

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS auto_flags JSONB,
  ADD COLUMN IF NOT EXISTS extracted_name TEXT,
  ADD COLUMN IF NOT EXISTS extracted_id_masked TEXT,
  ADD COLUMN IF NOT EXISTS extracted_issued_on DATE;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS kyc_flags JSONB,
  ADD COLUMN IF NOT EXISTS kyc_checks_run_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kyc_checks_run_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS kyc_signoff_acks JSONB,
  ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kyc_reviewed_by UUID REFERENCES users(id);

COMMENT ON COLUMN cases.kyc_flags IS
  'Snapshot of autoFlags() from the last "run checks": [{code,severity,field,message}].';
COMMENT ON COLUMN cases.kyc_signoff_acks IS
  'Manager acknowledgements at sign-off: [{code,reason}], one per warning/serious flag.';

CREATE TABLE IF NOT EXISTS case_kyc_portal_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  check_type TEXT NOT NULL,
  result TEXT NOT NULL,
  evidence_note TEXT,
  checked_by UUID REFERENCES users(id),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_kyc_portal_checks_case
  ON case_kyc_portal_checks(case_id, checked_at DESC);

ALTER TABLE case_kyc_portal_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read case_kyc_portal_checks"
  ON case_kyc_portal_checks FOR SELECT TO authenticated USING (true);

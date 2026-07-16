-- Contract rate phases: tiered pricing within a single contract tenure.
-- Phase clock uses phase_start_date on the contract (never resets on renewal).
-- Existing contracts: phase_start_date backfilled to start_date, no phases rows = flat rate.

-- 1. New table for phase schedule
CREATE TABLE IF NOT EXISTS contract_rate_phases (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID        NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  phase_order     SMALLINT    NOT NULL,        -- 1, 2, 3 ...
  duration_months SMALLINT    NOT NULL CHECK (duration_months > 0),
  monthly_rate    NUMERIC(12,2) NOT NULL CHECK (monthly_rate >= 0),
  created_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE contract_rate_phases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rate_phases_select" ON contract_rate_phases
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "rate_phases_insert" ON contract_rate_phases
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "rate_phases_update" ON contract_rate_phases
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "rate_phases_delete" ON contract_rate_phases
  FOR DELETE TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_rate_phases_contract
  ON contract_rate_phases(contract_id, phase_order);

-- 2. Add phase_start_date to contracts
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS phase_start_date DATE;

-- Backfill: existing contracts use their own start_date as the phase clock origin
UPDATE contracts
  SET phase_start_date = start_date
  WHERE phase_start_date IS NULL;

-- 3. Dedup billing_statements before adding unique constraint
--    Keep the earliest row (lowest ctid) per (contract_id, prepaid_year, prepaid_month, statement_type).
--    Prior double-generation bugs may have left duplicates.
DELETE FROM billing_statements bs
  WHERE bs.ctid NOT IN (
    SELECT MIN(b.ctid)
    FROM billing_statements b
    WHERE b.prepaid_year IS NOT NULL AND b.prepaid_month IS NOT NULL AND b.statement_type IS NOT NULL
    GROUP BY b.contract_id, b.prepaid_year, b.prepaid_month, b.statement_type
  )
  AND bs.prepaid_year IS NOT NULL
  AND bs.prepaid_month IS NOT NULL
  AND bs.statement_type IS NOT NULL;

-- 4. Unique constraint: one statement per (contract_id, prepaid_year, prepaid_month, statement_type)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_statement_contract_period_type'
  ) THEN
    ALTER TABLE billing_statements
      ADD CONSTRAINT uq_statement_contract_period_type
      UNIQUE (contract_id, prepaid_year, prepaid_month, statement_type);
  END IF;
END $$;

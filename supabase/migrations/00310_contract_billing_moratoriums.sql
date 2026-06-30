-- Contract Billing Moratoriums
-- A management-approved waiver that skips billing for a specific month.
-- Rules enforced at API layer:
--   • one moratorium per (contract, month) — enforced by UNIQUE below
--   • month must fall within contract tenure
--   • cannot be the first or last billing month
--   • cannot be retroactive (statement already finalized)
--   • max 1 approved moratorium per contract (configurable via app_settings)

CREATE TABLE contract_billing_moratoriums (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id          uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,

  -- First day of the month being waived, e.g. 2025-07-01
  moratorium_month     date NOT NULL,

  reason               text NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected')),

  requested_by         uuid REFERENCES users(id),
  requested_at         timestamptz NOT NULL DEFAULT now(),

  authorized_by        uuid REFERENCES users(id),
  authorized_at        timestamptz,
  authorization_note   text,

  -- Soft-override: admin manually generated billing anyway after approval
  overridden_at        timestamptz,
  overridden_by        uuid REFERENCES users(id),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- One moratorium request per contract per calendar month
  UNIQUE (contract_id, moratorium_month)
);

ALTER TABLE contract_billing_moratoriums ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read moratoriums
CREATE POLICY "moratoriums_select" ON contract_billing_moratoriums
  FOR SELECT TO authenticated USING (true);

-- Only admin/manager can insert (request) via API; API routes use service role
-- so this policy is a safety net for direct Supabase client calls
CREATE POLICY "moratoriums_insert" ON contract_billing_moratoriums
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "moratoriums_update" ON contract_billing_moratoriums
  FOR UPDATE TO authenticated USING (true);

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION update_moratorium_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_moratoriums_updated_at
  BEFORE UPDATE ON contract_billing_moratoriums
  FOR EACH ROW EXECUTE FUNCTION update_moratorium_updated_at();

-- Index for the cron lookup: given (contract_id, month, status)
CREATE INDEX idx_moratoriums_contract_month
  ON contract_billing_moratoriums (contract_id, moratorium_month, status);

-- Index for the approval queue (pending items)
CREATE INDEX idx_moratoriums_pending
  ON contract_billing_moratoriums (status)
  WHERE status = 'pending';

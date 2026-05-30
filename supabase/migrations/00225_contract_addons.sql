-- Contract recurring add-ons
-- Monthly charges added mid-contract (name boards, parking, lockers, etc.)
-- Auto-included in every billing cycle; pro-rated in the first month.

CREATE TABLE contract_addons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  effective_from  DATE NOT NULL,
  effective_until DATE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE contract_addons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_select" ON contract_addons
  FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "authenticated_insert" ON contract_addons
  FOR INSERT TO authenticated WITH CHECK (TRUE);

CREATE POLICY "authenticated_update" ON contract_addons
  FOR UPDATE TO authenticated USING (TRUE);

CREATE INDEX idx_contract_addons_contract_id ON contract_addons (contract_id);
CREATE INDEX idx_contract_addons_active ON contract_addons (contract_id, is_active) WHERE is_active = TRUE;

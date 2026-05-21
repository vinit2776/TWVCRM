-- Contract members — unified list for WiFi voucher + COSEC access per contract seat
CREATE TABLE contract_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  name          text NOT NULL,
  phone         text NOT NULL,
  email         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contract_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read contract_members"
  ON contract_members FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage contract_members"
  ON contract_members FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX idx_contract_members_contract ON contract_members(contract_id);

-- Link existing voucher_issuances to a contract member (nullable — backward compat)
ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS contract_member_id uuid REFERENCES contract_members(id);

-- Conference room device link — which COSEC device controls this room's door
ALTER TABLE spaces
  ADD COLUMN IF NOT EXISTS cosec_device_id uuid REFERENCES cosec_devices(id) ON DELETE SET NULL;

-- Access PIN for bookings (generated on confirmation, visible in booking detail)
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS access_pin text;

-- Add 'member' to cosec user type enum
ALTER TYPE cosec_user_type ADD VALUE IF NOT EXISTS 'member';

-- Updated_at trigger for contract_members
CREATE OR REPLACE FUNCTION update_contract_members_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contract_members_updated_at
  BEFORE UPDATE ON contract_members
  FOR EACH ROW EXECUTE FUNCTION update_contract_members_updated_at();

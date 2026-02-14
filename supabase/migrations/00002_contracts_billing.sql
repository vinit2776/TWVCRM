-- =============================================
-- TWV CRM - Contracts, Vouchers & Billing
-- =============================================

-- =============================================
-- ENUMS
-- =============================================
CREATE TYPE contract_status AS ENUM ('draft', 'active', 'renewed', 'expired', 'terminated');
CREATE TYPE billing_cycle AS ENUM ('monthly', 'quarterly', 'half_yearly', 'yearly');
CREATE TYPE voucher_status AS ENUM ('available', 'issued', 'expired', 'revoked');
CREATE TYPE usage_charge_status AS ENUM ('pending', 'billed', 'waived');
CREATE TYPE billing_statement_status AS ENUM ('draft', 'finalized', 'exported');

-- =============================================
-- CONTRACTS
-- =============================================
CREATE TABLE contracts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_number VARCHAR(50) UNIQUE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  title VARCHAR(500) NOT NULL,
  status contract_status DEFAULT 'draft',
  items JSONB DEFAULT '[]',
  subtotal DECIMAL(12, 2) DEFAULT 0,
  tax_percentage DECIMAL(5, 2) DEFAULT 18,
  tax_amount DECIMAL(12, 2) DEFAULT 0,
  discount_percentage DECIMAL(5, 2) DEFAULT 0,
  discount_amount DECIMAL(12, 2) DEFAULT 0,
  total_amount DECIMAL(12, 2) DEFAULT 0,
  billing_cycle billing_cycle NOT NULL,
  tenure_months INTEGER NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  next_billing_date DATE,
  seats INTEGER NOT NULL DEFAULT 1,
  terms_and_conditions TEXT,
  notes TEXT,
  activated_at TIMESTAMPTZ,
  renewed_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,
  termination_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contracts_lead_id ON contracts(lead_id);
CREATE INDEX idx_contracts_proposal_id ON contracts(proposal_id);
CREATE INDEX idx_contracts_status ON contracts(status);
CREATE INDEX idx_contracts_end_date ON contracts(end_date);
CREATE INDEX idx_contracts_next_billing_date ON contracts(next_billing_date);

CREATE OR REPLACE FUNCTION generate_contract_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(contract_number FROM 'TWV-C-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM contracts;
  NEW.contract_number := 'TWV-C-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contracts_number BEFORE INSERT ON contracts
  FOR EACH ROW WHEN (NEW.contract_number IS NULL)
  EXECUTE FUNCTION generate_contract_number();

CREATE TRIGGER update_contracts_updated_at BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- VOUCHER REPOSITORY
-- =============================================
CREATE TABLE voucher_repository (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  voucher_code VARCHAR(255) UNIQUE NOT NULL,
  status voucher_status DEFAULT 'available',
  metadata JSONB DEFAULT '{}',
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_voucher_repository_status ON voucher_repository(status);
CREATE INDEX idx_voucher_repository_code ON voucher_repository(voucher_code);

-- =============================================
-- VOUCHER ISSUANCES
-- =============================================
CREATE TABLE voucher_issuances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  voucher_id UUID NOT NULL REFERENCES voucher_repository(id) ON DELETE RESTRICT,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  seat_number INTEGER NOT NULL,
  issued_by UUID REFERENCES users(id) ON DELETE SET NULL,
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  valid_from DATE NOT NULL,
  valid_until DATE NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  UNIQUE(contract_id, seat_number),
  UNIQUE(voucher_id)
);

CREATE INDEX idx_voucher_issuances_contract_id ON voucher_issuances(contract_id);
CREATE INDEX idx_voucher_issuances_lead_id ON voucher_issuances(lead_id);

-- =============================================
-- BILLING STATEMENTS (created before usage_charges for FK)
-- =============================================
CREATE TABLE billing_statements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  statement_number VARCHAR(50) UNIQUE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  fixed_amount DECIMAL(12, 2) DEFAULT 0,
  usage_amount DECIMAL(12, 2) DEFAULT 0,
  subtotal DECIMAL(12, 2) DEFAULT 0,
  tax_percentage DECIMAL(5, 2) DEFAULT 18,
  tax_amount DECIMAL(12, 2) DEFAULT 0,
  total_amount DECIMAL(12, 2) DEFAULT 0,
  status billing_statement_status DEFAULT 'draft',
  finalized_at TIMESTAMPTZ,
  exported_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_billing_statements_contract_id ON billing_statements(contract_id);
CREATE INDEX idx_billing_statements_lead_id ON billing_statements(lead_id);
CREATE INDEX idx_billing_statements_status ON billing_statements(status);
CREATE INDEX idx_billing_statements_period ON billing_statements(period_start, period_end);

CREATE OR REPLACE FUNCTION generate_statement_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(statement_number FROM 'TWV-BS-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM billing_statements;
  NEW.statement_number := 'TWV-BS-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_statements_number BEFORE INSERT ON billing_statements
  FOR EACH ROW WHEN (NEW.statement_number IS NULL)
  EXECUTE FUNCTION generate_statement_number();

CREATE TRIGGER update_billing_statements_updated_at BEFORE UPDATE ON billing_statements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- USAGE CHARGES
-- =============================================
CREATE TABLE usage_charges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  description VARCHAR(500) NOT NULL,
  quantity DECIMAL(10, 2) DEFAULT 1,
  unit_price DECIMAL(12, 2) NOT NULL,
  total DECIMAL(12, 2) NOT NULL,
  charge_date DATE NOT NULL,
  status usage_charge_status DEFAULT 'pending',
  billing_statement_id UUID REFERENCES billing_statements(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_usage_charges_contract_id ON usage_charges(contract_id);
CREATE INDEX idx_usage_charges_lead_id ON usage_charges(lead_id);
CREATE INDEX idx_usage_charges_status ON usage_charges(status);
CREATE INDEX idx_usage_charges_charge_date ON usage_charges(charge_date);
CREATE INDEX idx_usage_charges_statement_id ON usage_charges(billing_statement_id);

CREATE TRIGGER update_usage_charges_updated_at BEFORE UPDATE ON usage_charges
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_repository ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_charges ENABLE ROW LEVEL SECURITY;

-- Contracts policies
CREATE POLICY "Authenticated users can read contracts"
  ON contracts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert contracts"
  ON contracts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update contracts"
  ON contracts FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete contracts"
  ON contracts FOR DELETE TO authenticated USING (true);

-- Voucher repository policies
CREATE POLICY "Authenticated users can read vouchers"
  ON voucher_repository FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert vouchers"
  ON voucher_repository FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update vouchers"
  ON voucher_repository FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete vouchers"
  ON voucher_repository FOR DELETE TO authenticated USING (true);

-- Voucher issuances policies
CREATE POLICY "Authenticated users can read voucher issuances"
  ON voucher_issuances FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert voucher issuances"
  ON voucher_issuances FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update voucher issuances"
  ON voucher_issuances FOR UPDATE TO authenticated USING (true);

-- Billing statements policies
CREATE POLICY "Authenticated users can read billing statements"
  ON billing_statements FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert billing statements"
  ON billing_statements FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update billing statements"
  ON billing_statements FOR UPDATE TO authenticated USING (true);

-- Usage charges policies
CREATE POLICY "Authenticated users can read usage charges"
  ON usage_charges FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert usage charges"
  ON usage_charges FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update usage charges"
  ON usage_charges FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete usage charges"
  ON usage_charges FOR DELETE TO authenticated USING (true);

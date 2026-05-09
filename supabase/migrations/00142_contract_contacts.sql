-- Multiple contact points per contract
-- Each contract can have its own set of contacts (finance, occupant, signatory, etc.)
-- independent of the lead's contacts
CREATE TABLE IF NOT EXISTS contract_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,

  -- Contact details
  full_name TEXT NOT NULL,
  designation TEXT,          -- e.g., "CFO", "Office Manager", "Director"
  email TEXT,
  phone TEXT,
  mobile TEXT,

  -- Role/type of this contact
  contact_role TEXT NOT NULL DEFAULT 'general'
    CHECK (contact_role IN (
      'primary',        -- Main point of contact for this contract
      'finance',        -- Finance/billing contact
      'occupant',       -- Actual person using the workspace
      'signatory',      -- Authorised signatory for this agreement
      'escalation',     -- Escalation contact (e.g., senior management)
      'it',             -- IT contact for technical coordination
      'general'         -- General/other contact
    )),

  -- Metadata
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,

  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_contract_contacts_contract_id ON contract_contacts(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_contacts_role ON contract_contacts(contact_role);

-- RLS
ALTER TABLE contract_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read contract contacts"
  ON contract_contacts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert contract contacts"
  ON contract_contacts FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update contract contacts"
  ON contract_contacts FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete contract contacts"
  ON contract_contacts FOR DELETE TO authenticated USING (true);

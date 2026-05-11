-- Multiple contact points per lead
-- Supports finance, occupant, signatory, and other roles
CREATE TABLE IF NOT EXISTS lead_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- Contact details
  full_name TEXT NOT NULL,
  designation TEXT,          -- e.g., "CFO", "Office Manager", "Director"
  email TEXT,
  phone TEXT,
  mobile TEXT,

  -- Role/type of this contact
  contact_role TEXT NOT NULL DEFAULT 'general'
    CHECK (contact_role IN (
      'primary',        -- Main point of contact (typically the lead itself)
      'finance',        -- Finance/billing contact
      'occupant',       -- Actual person using the workspace
      'signatory',      -- Authorised signatory for agreements
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
CREATE INDEX IF NOT EXISTS idx_lead_contacts_lead_id ON lead_contacts(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_role ON lead_contacts(contact_role);

-- RLS
ALTER TABLE lead_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read lead contacts"
  ON lead_contacts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert lead contacts"
  ON lead_contacts FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update lead contacts"
  ON lead_contacts FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete lead contacts"
  ON lead_contacts FOR DELETE TO authenticated USING (true);

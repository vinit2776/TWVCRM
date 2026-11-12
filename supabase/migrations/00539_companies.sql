-- ============================================================
-- Migration 00539: Companies (multi-company procurement)
-- ============================================================
-- Introduces a first-class "company" entity so procurement (material
-- requests, purchase orders, vendor bills, budgets, locations) can be run
-- for more than one legal entity through the same app. Seeds the existing
-- Workvilla identity (previously hardcoded in po-pdf-generator.ts) plus the
-- new MedWorks Plus entity. Scoping of procurement tables to company_id
-- happens in a follow-up migration.

CREATE TABLE IF NOT EXISTS companies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,           -- registered legal name
  brand_name TEXT NOT NULL,           -- display brand shown in the UI/PDFs
  gstin      TEXT,
  address    TEXT,
  city       TEXT,
  state      TEXT,
  pincode    TEXT,
  phone      TEXT,
  email      TEXT,
  pr_prefix   TEXT NOT NULL,          -- e.g. 'PR', 'MWP-PR'
  po_prefix   TEXT NOT NULL,          -- e.g. 'PO', 'MWP-PO'
  bill_prefix TEXT NOT NULL,          -- e.g. 'BILL', 'MWP-BILL'
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pr_prefix),
  UNIQUE (po_prefix),
  UNIQUE (bill_prefix)
);

CREATE OR REPLACE FUNCTION update_companies_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_companies_updated_at();

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read companies"
  ON companies FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin and manager can insert companies"
  ON companies FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true)
  );

CREATE POLICY "Admin and manager can update companies"
  ON companies FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true)
  );

CREATE POLICY "Admin can delete companies"
  ON companies FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role = 'admin' AND is_active = true)
  );

-- Seed: Workvilla (existing identity, previously hardcoded in po-pdf-generator.ts)
INSERT INTO companies (name, brand_name, gstin, address, city, state, pincode, phone, email, pr_prefix, po_prefix, bill_prefix)
VALUES (
  'Sree Design Infrastructure Pvt Ltd',
  'Workvilla',
  '33AAACU4245J1ZF',
  'Prakash Presidium, 110, Mahatma Gandhi Road, Nungambakkam',
  'Chennai',
  'Tamil Nadu',
  '600034',
  '+91 97910 97900',
  'contact@theworkvilla.com',
  'PR',
  'PO',
  'BILL'
);

-- Seed: MedWorks Plus (new entity, GSTIN from GST REG-06 certificate)
INSERT INTO companies (name, brand_name, gstin, address, city, state, pincode, phone, email, pr_prefix, po_prefix, bill_prefix)
VALUES (
  'Medworks Private Limited',
  'MedWorks Plus',
  '33AADCE9026A2Z5',
  '5th Floor, 110/1, Mahatma Gandhi Road, Nungambakkam',
  'Chennai',
  'Tamil Nadu',
  '600034',
  '+91 73388 33692',
  'contact@medworksplus.com',
  'MWP-PR',
  'MWP-PO',
  'MWP-BILL'
);

-- ==========================================
-- Migration 00015: Aggregator & Virtual Office Case Management
-- ==========================================

-- ==========================================
-- 1. ENUM TYPES
-- ==========================================

CREATE TYPE aggregator_status AS ENUM ('active', 'inactive', 'suspended');

CREATE TYPE vo_purpose AS ENUM ('gst_registration', 'mca_registration', 'branch_office', 'mail_handling', 'business_address');

CREATE TYPE entity_type AS ENUM ('individual', 'proprietorship', 'partnership', 'llp', 'pvt_ltd', 'public_ltd', 'trust', 'society', 'huf', 'other');

CREATE TYPE case_status AS ENUM (
  'intake_received', 'docs_requested', 'docs_received', 'under_review',
  'compliance_check', 'internal_approved', 'sent_for_client_approval',
  'client_approved', 'signing_in_progress', 'executed',
  'invoiced', 'active', 'renewal_due', 'renewed', 'lapsed'
);

CREATE TYPE case_doc_status AS ENUM ('pending', 'uploaded', 'approved', 'rejected');

CREATE TYPE compliance_check_status AS ENUM ('pending', 'passed', 'failed', 'waived');

CREATE TYPE agreement_status AS ENUM ('draft', 'pending_internal_approval', 'internally_approved', 'sent_to_client', 'client_approved', 'signing', 'executed', 'expired');

CREATE TYPE email_direction AS ENUM ('inbound', 'outbound');

CREATE TYPE agg_invoice_status AS ENUM ('draft', 'sent', 'paid', 'overdue', 'cancelled');


-- ==========================================
-- 2. AGGREGATORS TABLE
-- ==========================================

CREATE TABLE aggregators (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50) UNIQUE,
  status aggregator_status DEFAULT 'active',
  company_name VARCHAR(255),
  gst_number VARCHAR(20),
  pan_number VARCHAR(15),
  email_domain VARCHAR(255),
  primary_email VARCHAR(255),
  primary_phone VARCHAR(20),
  billing_address TEXT,
  billing_city VARCHAR(100),
  billing_state VARCHAR(100),
  billing_pincode VARCHAR(10),
  same_state_as_twv BOOLEAN DEFAULT false,
  commission_percentage DECIMAL(5,2) DEFAULT 0,
  default_rate_card JSONB DEFAULT '{}',
  kyc_verified BOOLEAN DEFAULT false,
  kyc_verified_at TIMESTAMPTZ,
  kyc_verified_by UUID REFERENCES users(id),
  agreement_signed BOOLEAN DEFAULT false,
  agreement_document_id UUID REFERENCES documents(id),
  notes TEXT,
  tags TEXT[] DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_aggregators_status ON aggregators(status);
CREATE INDEX idx_aggregators_code ON aggregators(code);
CREATE INDEX idx_aggregators_email_domain ON aggregators(email_domain);
CREATE INDEX idx_aggregators_gst ON aggregators(gst_number);
CREATE INDEX idx_aggregators_created_at ON aggregators(created_at DESC);

-- Auto-generate aggregator code
CREATE OR REPLACE FUNCTION generate_aggregator_code()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'TWV-AGG-(\d+)') AS INTEGER)), 0) + 1
    INTO next_num FROM aggregators;
  NEW.code := 'TWV-AGG-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER aggregators_code BEFORE INSERT ON aggregators
  FOR EACH ROW WHEN (NEW.code IS NULL)
  EXECUTE FUNCTION generate_aggregator_code();


-- ==========================================
-- 3. AGGREGATOR CONTACTS TABLE
-- ==========================================

CREATE TABLE aggregator_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  aggregator_id UUID NOT NULL REFERENCES aggregators(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  designation VARCHAR(100),
  is_primary BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agg_contacts_aggregator ON aggregator_contacts(aggregator_id);
CREATE INDEX idx_agg_contacts_email ON aggregator_contacts(email);


-- ==========================================
-- 4. AGGREGATOR RATE CARDS TABLE
-- ==========================================

CREATE TABLE aggregator_rate_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  aggregator_id UUID NOT NULL REFERENCES aggregators(id) ON DELETE CASCADE,
  purpose vo_purpose NOT NULL,
  location_id UUID REFERENCES locations(id),
  rate DECIMAL(12,2) NOT NULL,
  tenure_months INTEGER DEFAULT 12,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  effective_from DATE DEFAULT CURRENT_DATE,
  effective_until DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(aggregator_id, purpose, location_id)
);

CREATE INDEX idx_agg_rate_cards_aggregator ON aggregator_rate_cards(aggregator_id);
CREATE INDEX idx_agg_rate_cards_purpose ON aggregator_rate_cards(purpose);


-- ==========================================
-- 5. CASES TABLE (Core Entity)
-- ==========================================

CREATE TABLE cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_number VARCHAR(50) UNIQUE,
  aggregator_id UUID NOT NULL REFERENCES aggregators(id) ON DELETE RESTRICT,
  aggregator_contact_id UUID REFERENCES aggregator_contacts(id),
  location_id UUID REFERENCES locations(id),
  status case_status DEFAULT 'intake_received',
  purpose vo_purpose NOT NULL,
  is_renewal BOOLEAN DEFAULT false,
  parent_case_id UUID REFERENCES cases(id) ON DELETE SET NULL,

  -- End-client details
  client_name VARCHAR(255) NOT NULL,
  client_entity_type entity_type NOT NULL,
  client_company_name VARCHAR(255),
  client_gst_number VARCHAR(20),
  client_pan_number VARCHAR(15),
  client_cin_number VARCHAR(25),
  client_email VARCHAR(255),
  client_phone VARCHAR(20),
  client_address TEXT,
  client_city VARCHAR(100),
  client_state VARCHAR(100),
  client_pincode VARCHAR(10),

  -- Financials
  rate DECIMAL(12,2),
  tenure_months INTEGER DEFAULT 12,
  start_date DATE,
  end_date DATE,
  security_deposit DECIMAL(12,2) DEFAULT 0,

  -- Agreement reference (FK added after case_agreements table)
  agreement_id UUID,

  -- Compliance
  compliance_passed BOOLEAN DEFAULT false,
  compliance_passed_at TIMESTAMPTZ,
  compliance_passed_by UUID REFERENCES users(id),

  -- Workflow timestamps
  docs_requested_at TIMESTAMPTZ,
  docs_received_at TIMESTAMPTZ,
  review_started_at TIMESTAMPTZ,
  internal_approved_at TIMESTAMPTZ,
  internal_approved_by UUID REFERENCES users(id),
  sent_for_client_approval_at TIMESTAMPTZ,
  client_approved_at TIMESTAMPTZ,
  signing_started_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  invoiced_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  renewal_due_at TIMESTAMPTZ,
  renewed_at TIMESTAMPTZ,
  lapsed_at TIMESTAMPTZ,

  -- Inbound email reference
  source_email_id VARCHAR(255),
  email_thread_id VARCHAR(255),

  -- Meta
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cases_case_number ON cases(case_number);
CREATE INDEX idx_cases_aggregator ON cases(aggregator_id);
CREATE INDEX idx_cases_status ON cases(status);
CREATE INDEX idx_cases_purpose ON cases(purpose);
CREATE INDEX idx_cases_client_company ON cases(client_company_name);
CREATE INDEX idx_cases_client_gst ON cases(client_gst_number);
CREATE INDEX idx_cases_client_pan ON cases(client_pan_number);
CREATE INDEX idx_cases_location ON cases(location_id);
CREATE INDEX idx_cases_assigned_to ON cases(assigned_to);
CREATE INDEX idx_cases_created_at ON cases(created_at DESC);
CREATE INDEX idx_cases_renewal_due ON cases(renewal_due_at) WHERE renewal_due_at IS NOT NULL;
CREATE INDEX idx_cases_email_thread ON cases(email_thread_id);
CREATE INDEX idx_cases_parent ON cases(parent_case_id) WHERE parent_case_id IS NOT NULL;

-- Auto-generate case number
CREATE OR REPLACE FUNCTION generate_case_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(case_number FROM 'TWV-CASE-(\d+)') AS INTEGER)), 0) + 1
    INTO next_num FROM cases;
  NEW.case_number := 'TWV-CASE-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cases_number BEFORE INSERT ON cases
  FOR EACH ROW WHEN (NEW.case_number IS NULL)
  EXECUTE FUNCTION generate_case_number();


-- ==========================================
-- 6. CASE DOCUMENTS TABLE
-- ==========================================

CREATE TABLE case_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  document_type VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  is_required BOOLEAN DEFAULT true,
  status case_doc_status DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_case_docs_case ON case_documents(case_id);
CREATE INDEX idx_case_docs_status ON case_documents(status);
CREATE INDEX idx_case_docs_type ON case_documents(document_type);


-- ==========================================
-- 7. CASE COMMENTS TABLE
-- ==========================================

CREATE TABLE case_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT true,
  attachment_id UUID REFERENCES documents(id),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_case_comments_case ON case_comments(case_id);
CREATE INDEX idx_case_comments_created ON case_comments(created_at DESC);


-- ==========================================
-- 8. CASE COMPLIANCE CHECKS TABLE
-- ==========================================

CREATE TABLE case_compliance_checks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  check_name VARCHAR(255) NOT NULL,
  check_category VARCHAR(100),
  status compliance_check_status DEFAULT 'pending',
  checked_by UUID REFERENCES users(id),
  checked_at TIMESTAMPTZ,
  notes TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_compliance_case ON case_compliance_checks(case_id);
CREATE INDEX idx_compliance_status ON case_compliance_checks(status);


-- ==========================================
-- 9. CASE AGREEMENTS TABLE
-- ==========================================

CREATE TABLE case_agreements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  agreement_number VARCHAR(50) UNIQUE,
  template_key VARCHAR(100) NOT NULL,
  status agreement_status DEFAULT 'draft',
  variables JSONB DEFAULT '{}',
  generated_document_id UUID REFERENCES documents(id),
  signed_document_id UUID REFERENCES documents(id),

  -- Internal approval
  internal_approved_by UUID REFERENCES users(id),
  internal_approved_at TIMESTAMPTZ,

  -- Client approval
  sent_to_client_at TIMESTAMPTZ,
  sent_to_email VARCHAR(255),
  client_approved_at TIMESTAMPTZ,

  -- e-Sign (Digio)
  digio_document_id VARCHAR(255),
  digio_sign_url TEXT,
  digio_status VARCHAR(50),
  signed_at TIMESTAMPTZ,

  valid_from DATE,
  valid_until DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agreements_case ON case_agreements(case_id);
CREATE INDEX idx_agreements_status ON case_agreements(status);
CREATE INDEX idx_agreements_number ON case_agreements(agreement_number);

-- Auto-generate agreement number
CREATE OR REPLACE FUNCTION generate_agreement_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(agreement_number FROM 'TWV-AGR-(\d+)') AS INTEGER)), 0) + 1
    INTO next_num FROM case_agreements;
  NEW.agreement_number := 'TWV-AGR-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agreements_number BEFORE INSERT ON case_agreements
  FOR EACH ROW WHEN (NEW.agreement_number IS NULL)
  EXECUTE FUNCTION generate_agreement_number();


-- ==========================================
-- 10. CASE EMAILS TABLE
-- ==========================================

CREATE TABLE case_emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  direction email_direction NOT NULL,
  gmail_message_id VARCHAR(255),
  gmail_thread_id VARCHAR(255),
  from_email VARCHAR(255),
  to_emails TEXT[] DEFAULT '{}',
  cc_emails TEXT[] DEFAULT '{}',
  subject VARCHAR(500),
  body_preview TEXT,
  has_attachments BOOLEAN DEFAULT false,
  parsed_data JSONB DEFAULT '{}',
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_case_emails_case ON case_emails(case_id);
CREATE INDEX idx_case_emails_gmail ON case_emails(gmail_message_id);
CREATE INDEX idx_case_emails_thread ON case_emails(gmail_thread_id);
CREATE INDEX idx_case_emails_created ON case_emails(created_at DESC);


-- ==========================================
-- 11. AGGREGATOR INVOICES TABLE
-- ==========================================

CREATE TABLE aggregator_invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_number VARCHAR(50) UNIQUE,
  aggregator_id UUID NOT NULL REFERENCES aggregators(id) ON DELETE RESTRICT,
  period_month INTEGER NOT NULL CHECK (period_month >= 1 AND period_month <= 12),
  period_year INTEGER NOT NULL,
  status agg_invoice_status DEFAULT 'draft',

  items JSONB DEFAULT '[]',

  subtotal DECIMAL(12,2) DEFAULT 0,
  cgst_amount DECIMAL(12,2) DEFAULT 0,
  sgst_amount DECIMAL(12,2) DEFAULT 0,
  igst_amount DECIMAL(12,2) DEFAULT 0,
  total_amount DECIMAL(12,2) DEFAULT 0,

  is_interstate BOOLEAN DEFAULT false,
  tax_percentage DECIMAL(5,2) DEFAULT 18,

  sent_at TIMESTAMPTZ,
  sent_to VARCHAR(255),
  paid_at TIMESTAMPTZ,
  payment_reference VARCHAR(255),
  due_date DATE,
  notes TEXT,

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(aggregator_id, period_month, period_year)
);

CREATE INDEX idx_agg_invoices_aggregator ON aggregator_invoices(aggregator_id);
CREATE INDEX idx_agg_invoices_period ON aggregator_invoices(period_year, period_month);
CREATE INDEX idx_agg_invoices_status ON aggregator_invoices(status);

-- Auto-generate aggregator invoice number
CREATE OR REPLACE FUNCTION generate_agg_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 'TWV-AI-(\d+)') AS INTEGER)), 0) + 1
    INTO next_num FROM aggregator_invoices;
  NEW.invoice_number := 'TWV-AI-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agg_invoices_number BEFORE INSERT ON aggregator_invoices
  FOR EACH ROW WHEN (NEW.invoice_number IS NULL)
  EXECUTE FUNCTION generate_agg_invoice_number();


-- ==========================================
-- 12. ADD FK FROM CASES TO CASE_AGREEMENTS
-- ==========================================

ALTER TABLE cases ADD CONSTRAINT fk_cases_agreement
  FOREIGN KEY (agreement_id) REFERENCES case_agreements(id) ON DELETE SET NULL;


-- ==========================================
-- 13. UPDATED_AT TRIGGERS FOR ALL NEW TABLES
-- ==========================================

CREATE TRIGGER update_aggregators_updated_at BEFORE UPDATE ON aggregators
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_agg_contacts_updated_at BEFORE UPDATE ON aggregator_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_agg_rate_cards_updated_at BEFORE UPDATE ON aggregator_rate_cards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_cases_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_case_docs_updated_at BEFORE UPDATE ON case_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_case_comments_updated_at BEFORE UPDATE ON case_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_compliance_updated_at BEFORE UPDATE ON case_compliance_checks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_agreements_updated_at BEFORE UPDATE ON case_agreements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_agg_invoices_updated_at BEFORE UPDATE ON aggregator_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ==========================================
-- 14. ROW LEVEL SECURITY
-- ==========================================

ALTER TABLE aggregators ENABLE ROW LEVEL SECURITY;
ALTER TABLE aggregator_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aggregator_rate_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_compliance_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE aggregator_invoices ENABLE ROW LEVEL SECURITY;

-- Aggregators
CREATE POLICY "Authenticated users can read aggregators"
  ON aggregators FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert aggregators"
  ON aggregators FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update aggregators"
  ON aggregators FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete aggregators"
  ON aggregators FOR DELETE TO authenticated USING (true);

-- Aggregator Contacts
CREATE POLICY "Authenticated users can read aggregator_contacts"
  ON aggregator_contacts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert aggregator_contacts"
  ON aggregator_contacts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update aggregator_contacts"
  ON aggregator_contacts FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete aggregator_contacts"
  ON aggregator_contacts FOR DELETE TO authenticated USING (true);

-- Aggregator Rate Cards
CREATE POLICY "Authenticated users can read aggregator_rate_cards"
  ON aggregator_rate_cards FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert aggregator_rate_cards"
  ON aggregator_rate_cards FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update aggregator_rate_cards"
  ON aggregator_rate_cards FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete aggregator_rate_cards"
  ON aggregator_rate_cards FOR DELETE TO authenticated USING (true);

-- Cases
CREATE POLICY "Authenticated users can read cases"
  ON cases FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert cases"
  ON cases FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update cases"
  ON cases FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete cases"
  ON cases FOR DELETE TO authenticated USING (true);

-- Case Documents
CREATE POLICY "Authenticated users can read case_documents"
  ON case_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert case_documents"
  ON case_documents FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update case_documents"
  ON case_documents FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete case_documents"
  ON case_documents FOR DELETE TO authenticated USING (true);

-- Case Comments
CREATE POLICY "Authenticated users can read case_comments"
  ON case_comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert case_comments"
  ON case_comments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update case_comments"
  ON case_comments FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete case_comments"
  ON case_comments FOR DELETE TO authenticated USING (true);

-- Case Compliance Checks
CREATE POLICY "Authenticated users can read case_compliance_checks"
  ON case_compliance_checks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert case_compliance_checks"
  ON case_compliance_checks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update case_compliance_checks"
  ON case_compliance_checks FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete case_compliance_checks"
  ON case_compliance_checks FOR DELETE TO authenticated USING (true);

-- Case Agreements
CREATE POLICY "Authenticated users can read case_agreements"
  ON case_agreements FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert case_agreements"
  ON case_agreements FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update case_agreements"
  ON case_agreements FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete case_agreements"
  ON case_agreements FOR DELETE TO authenticated USING (true);

-- Case Emails
CREATE POLICY "Authenticated users can read case_emails"
  ON case_emails FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert case_emails"
  ON case_emails FOR INSERT TO authenticated WITH CHECK (true);

-- Aggregator Invoices
CREATE POLICY "Authenticated users can read aggregator_invoices"
  ON aggregator_invoices FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert aggregator_invoices"
  ON aggregator_invoices FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update aggregator_invoices"
  ON aggregator_invoices FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete aggregator_invoices"
  ON aggregator_invoices FOR DELETE TO authenticated USING (true);

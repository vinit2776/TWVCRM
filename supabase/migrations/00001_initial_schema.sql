-- =============================================
-- TWV CRM - Initial Schema
-- =============================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- =============================================
-- ENUMS
-- =============================================
CREATE TYPE user_role AS ENUM ('admin', 'manager', 'sales_rep');
CREATE TYPE lead_status AS ENUM (
  'new', 'contacted', 'tour_scheduled', 'tour_completed',
  'proposal_sent', 'negotiating', 'won', 'lost'
);
CREATE TYPE lead_source AS ENUM (
  'meta_ads', 'direct_walkin', 'online_form', 'referral',
  'social_media', 'advertisement', 'cold_call', 'event', 'partner', 'other'
);
CREATE TYPE workspace_type AS ENUM (
  'hot_desk', 'dedicated_desk', 'private_office',
  'meeting_room', 'conference_room', 'virtual_office'
);
CREATE TYPE lead_rating AS ENUM ('none', 'hot', 'warm', 'cold');
CREATE TYPE activity_type AS ENUM ('call', 'meeting', 'note', 'email', 'tour');
CREATE TYPE call_outcome AS ENUM (
  'connected', 'no_answer', 'voicemail', 'busy',
  'wrong_number', 'callback_scheduled'
);
CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE proposal_status AS ENUM ('draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired');
CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'paid', 'overdue', 'cancelled');

-- =============================================
-- FUNCTIONS
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- USERS
-- =============================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  auth_id UUID UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  phone VARCHAR(20),
  role user_role DEFAULT 'sales_rep',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_users_auth_id ON users(auth_id);
CREATE INDEX idx_users_email ON users(email);

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- LEADS
-- =============================================
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  company VARCHAR(255),
  aggregator_contact_name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(20),
  mobile VARCHAR(20),
  website VARCHAR(500),
  title VARCHAR(255),
  secondary_email VARCHAR(255),
  status lead_status DEFAULT 'new',
  source lead_source DEFAULT 'other',
  industry VARCHAR(255),
  no_of_employees INTEGER,
  rating lead_rating DEFAULT 'none',
  score INTEGER DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  -- Coworking-specific
  workspace_type workspace_type,
  seat_capacity INTEGER,
  preferred_location VARCHAR(255),
  working_hours VARCHAR(255),
  budget_per_seat DECIMAL(12, 2),
  -- Address
  street VARCHAR(500),
  city VARCHAR(255),
  state VARCHAR(255),
  zip_code VARCHAR(20),
  country VARCHAR(255),
  -- Links
  enquiry_form_google TEXT,
  enquiry_form_direct TEXT,
  -- Meta
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  converted_at TIMESTAMPTZ,
  lost_at TIMESTAMPTZ,
  lost_reason TEXT,
  search_vector TSVECTOR
);

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_source ON leads(source);
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX idx_leads_search ON leads USING gin(search_vector);
CREATE INDEX idx_leads_tags ON leads USING gin(tags);

CREATE OR REPLACE FUNCTION update_lead_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.first_name, '') || ' ' ||
    COALESCE(NEW.last_name, '') || ' ' ||
    COALESCE(NEW.email, '') || ' ' ||
    COALESCE(NEW.phone, '') || ' ' ||
    COALESCE(NEW.company, '') || ' ' ||
    COALESCE(array_to_string(NEW.tags, ' '), '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_search_vector_update
  BEFORE INSERT OR UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_lead_search_vector();

CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- ACTIVITIES
-- =============================================
CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type activity_type NOT NULL,
  subject VARCHAR(500),
  description TEXT,
  call_duration_seconds INTEGER,
  call_outcome call_outcome,
  meeting_location VARCHAR(255),
  meeting_start_at TIMESTAMPTZ,
  meeting_end_at TIMESTAMPTZ,
  follow_up_date TIMESTAMPTZ,
  follow_up_notes TEXT,
  is_follow_up_done BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_activities_lead_id ON activities(lead_id);
CREATE INDEX idx_activities_type ON activities(type);
CREATE INDEX idx_activities_created_at ON activities(created_at DESC);
CREATE INDEX idx_activities_follow_up ON activities(follow_up_date)
  WHERE follow_up_date IS NOT NULL AND is_follow_up_done = false;

CREATE TRIGGER update_activities_updated_at BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- MEETING ATTENDEES
-- =============================================
CREATE TABLE meeting_attendees (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  external_name VARCHAR(255),
  external_email VARCHAR(255),
  is_external BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_meeting_attendees_activity ON meeting_attendees(activity_id);

-- =============================================
-- MEETING MINUTES
-- =============================================
CREATE TABLE meeting_minutes (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  activity_id UUID UNIQUE NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  agenda TEXT,
  minutes_content TEXT NOT NULL,
  decisions TEXT,
  action_items JSONB DEFAULT '[]',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_meeting_minutes_updated_at BEFORE UPDATE ON meeting_minutes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- PROPOSALS
-- =============================================
CREATE TABLE proposals (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  proposal_number VARCHAR(50) UNIQUE,
  title VARCHAR(500) NOT NULL,
  status proposal_status DEFAULT 'draft',
  description TEXT,
  items JSONB DEFAULT '[]',
  subtotal DECIMAL(12, 2) DEFAULT 0,
  tax_percentage DECIMAL(5, 2) DEFAULT 18,
  tax_amount DECIMAL(12, 2) DEFAULT 0,
  discount_percentage DECIMAL(5, 2) DEFAULT 0,
  discount_amount DECIMAL(12, 2) DEFAULT 0,
  total_amount DECIMAL(12, 2) DEFAULT 0,
  valid_until DATE,
  terms_and_conditions TEXT,
  notes TEXT,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_proposals_lead_id ON proposals(lead_id);
CREATE INDEX idx_proposals_status ON proposals(status);

CREATE OR REPLACE FUNCTION generate_proposal_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(proposal_number FROM 'TWV-P-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM proposals;
  NEW.proposal_number := 'TWV-P-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposals_number BEFORE INSERT ON proposals
  FOR EACH ROW WHEN (NEW.proposal_number IS NULL)
  EXECUTE FUNCTION generate_proposal_number();

CREATE TRIGGER update_proposals_updated_at BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- PROFORMA INVOICES
-- =============================================
CREATE TABLE proforma_invoices (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  proposal_id UUID REFERENCES proposals(id) ON DELETE SET NULL,
  invoice_number VARCHAR(50) UNIQUE,
  title VARCHAR(500) NOT NULL,
  status invoice_status DEFAULT 'draft',
  items JSONB DEFAULT '[]',
  subtotal DECIMAL(12, 2) DEFAULT 0,
  tax_percentage DECIMAL(5, 2) DEFAULT 18,
  tax_amount DECIMAL(12, 2) DEFAULT 0,
  discount_percentage DECIMAL(5, 2) DEFAULT 0,
  discount_amount DECIMAL(12, 2) DEFAULT 0,
  total_amount DECIMAL(12, 2) DEFAULT 0,
  due_date DATE,
  paid_at TIMESTAMPTZ,
  payment_reference VARCHAR(255),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invoices_lead_id ON proforma_invoices(lead_id);
CREATE INDEX idx_invoices_status ON proforma_invoices(status);

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(invoice_number FROM 'TWV-PI-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM proforma_invoices;
  NEW.invoice_number := 'TWV-PI-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_number BEFORE INSERT ON proforma_invoices
  FOR EACH ROW WHEN (NEW.invoice_number IS NULL)
  EXECUTE FUNCTION generate_invoice_number();

CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- TASKS
-- =============================================
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status task_status DEFAULT 'todo',
  priority task_priority DEFAULT 'medium',
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  tags TEXT[] DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX idx_tasks_lead_id ON tasks(lead_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);

CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- DOCUMENT FOLDERS
-- =============================================
CREATE TABLE document_folders (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  parent_folder_id UUID REFERENCES document_folders(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_folders_parent ON document_folders(parent_folder_id);

-- =============================================
-- DOCUMENTS
-- =============================================
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  file_name VARCHAR(500) NOT NULL,
  file_path TEXT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  folder_id UUID REFERENCES document_folders(id) ON DELETE SET NULL,
  category VARCHAR(100),
  tags TEXT[] DEFAULT '{}',
  version INTEGER DEFAULT 1,
  parent_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_documents_folder ON documents(folder_id);
CREATE INDEX idx_documents_category ON documents(category);
CREATE INDEX idx_documents_tags ON documents USING gin(tags);

CREATE TRIGGER update_documents_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- LEAD DOCUMENTS (junction)
-- =============================================
CREATE TABLE lead_documents (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(lead_id, document_id)
);

CREATE INDEX idx_lead_docs_lead ON lead_documents(lead_id);
CREATE INDEX idx_lead_docs_doc ON lead_documents(document_id);

-- =============================================
-- AUDIT TRAIL
-- =============================================
CREATE TABLE audit_trail (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,
  changes JSONB DEFAULT '{}',
  performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_trail(entity_type, entity_id);
CREATE INDEX idx_audit_created_at ON audit_trail(created_at DESC);

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_minutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_trail ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read all data (team CRM)
CREATE POLICY "auth_read" ON users FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON leads FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON activities FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON meeting_attendees FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON meeting_minutes FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON proposals FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON proforma_invoices FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON tasks FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON document_folders FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON documents FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON lead_documents FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_read" ON audit_trail FOR SELECT USING (auth.uid() IS NOT NULL);

-- All authenticated users can insert/update
CREATE POLICY "auth_insert" ON leads FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON leads FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON activities FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON activities FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON meeting_attendees FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON meeting_minutes FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON meeting_minutes FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON proposals FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON proposals FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON proforma_invoices FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON proforma_invoices FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON tasks FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON tasks FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON document_folders FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON document_folders FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON documents FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON documents FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON lead_documents FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON audit_trail FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON users FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON users FOR UPDATE USING (auth.uid() IS NOT NULL);

-- Delete policies (admin only via service role key for now)
CREATE POLICY "auth_delete" ON leads FOR DELETE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON activities FOR DELETE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON tasks FOR DELETE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON documents FOR DELETE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON lead_documents FOR DELETE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON proposals FOR DELETE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON proforma_invoices FOR DELETE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON document_folders FOR DELETE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON meeting_attendees FOR DELETE USING (auth.uid() IS NOT NULL);

-- =============================================
-- AUTO-CREATE USER ON AUTH SIGNUP
-- =============================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (auth_id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

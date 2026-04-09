-- Contract KYC documents with upload and approval workflow
CREATE TABLE IF NOT EXISTS contract_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  document_type VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  is_required BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'pending', -- pending, uploaded, approved, rejected
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_docs_contract ON contract_documents(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_docs_status ON contract_documents(status);

ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read contract_documents"
  ON contract_documents FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert contract_documents"
  ON contract_documents FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update contract_documents"
  ON contract_documents FOR UPDATE USING (auth.uid() IS NOT NULL);

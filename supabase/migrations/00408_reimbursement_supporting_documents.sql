-- Reimbursement supporting documents
-- Customer-facing proof (receipts, vendor bills) attached to a reimbursement
-- billing statement so the invoice sent to the customer is self-explanatory.
-- One statement can have many supporting documents.

CREATE TABLE reimbursement_supporting_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id UUID NOT NULL REFERENCES billing_statements(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_mime_type VARCHAR(100) NOT NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reimbursement_supporting_documents_statement_id ON reimbursement_supporting_documents(billing_statement_id);

ALTER TABLE reimbursement_supporting_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read reimbursement_supporting_documents"
  ON reimbursement_supporting_documents FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert reimbursement_supporting_documents"
  ON reimbursement_supporting_documents FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update reimbursement_supporting_documents"
  ON reimbursement_supporting_documents FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete reimbursement_supporting_documents"
  ON reimbursement_supporting_documents FOR DELETE USING (auth.uid() IS NOT NULL);

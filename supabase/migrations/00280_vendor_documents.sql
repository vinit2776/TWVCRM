-- Vendor catalogues, price lists, quotations, and general documents repository
CREATE TABLE vendor_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES procurement_vendors(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('price_list', 'catalogue', 'quotation', 'other')),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size_bytes INTEGER,
  file_mime_type TEXT,
  notes TEXT,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vendor_documents_vendor_id ON vendor_documents(vendor_id);
CREATE INDEX idx_vendor_documents_category ON vendor_documents(category);

ALTER TABLE vendor_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view vendor documents"
  ON vendor_documents FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert vendor documents"
  ON vendor_documents FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can delete vendor documents"
  ON vendor_documents FOR DELETE TO authenticated USING (true);

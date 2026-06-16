-- Material request quotations / estimates
-- Approvers need vendor quotes attached to a material request before approving.
-- One MR can have many quotations (one per vendor / per estimate).

CREATE TABLE material_request_quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  vendor_name VARCHAR(255) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL CHECK (amount >= 0),
  file_path TEXT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_mime_type VARCHAR(100) NOT NULL,
  notes TEXT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_material_request_quotations_pr_id ON material_request_quotations(pr_id);

ALTER TABLE material_request_quotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read material_request_quotations"
  ON material_request_quotations FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert material_request_quotations"
  ON material_request_quotations FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update material_request_quotations"
  ON material_request_quotations FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete material_request_quotations"
  ON material_request_quotations FOR DELETE USING (auth.uid() IS NOT NULL);

-- Phase 3: Asset Documents with two-tier access (commercial vs operational)

-- Document access tier enum
CREATE TYPE asset_document_tier AS ENUM ('commercial', 'operational');

CREATE TABLE IF NOT EXISTS asset_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID NOT NULL REFERENCES facility_assets(id) ON DELETE CASCADE,
  tier        asset_document_tier NOT NULL DEFAULT 'operational',
  label       TEXT NOT NULL,                -- e.g. "Purchase Invoice", "Installation Photo"
  file_url    TEXT NOT NULL,
  file_name   TEXT,
  file_size   INTEGER,                      -- bytes
  mime_type   TEXT,
  notes       TEXT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_asset_documents_asset ON asset_documents(asset_id);
CREATE INDEX idx_asset_documents_tier  ON asset_documents(tier);

ALTER TABLE asset_documents ENABLE ROW LEVEL SECURITY;

-- Operational docs: fms, admin, manager, it_manager, it_technician can read
CREATE POLICY "asset_docs_select_operational" ON asset_documents
  FOR SELECT TO authenticated
  USING (
    tier = 'operational'
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role IN ('admin','manager','fms','it_manager','it_technician')
    )
  );

-- Commercial docs: admin, manager, accounts can read
CREATE POLICY "asset_docs_select_commercial" ON asset_documents
  FOR SELECT TO authenticated
  USING (
    tier = 'commercial'
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role IN ('admin','manager','accounts','office_admin')
    )
  );

-- Insert: admin, manager, fms, accounts
CREATE POLICY "asset_docs_insert" ON asset_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role IN ('admin','manager','fms','accounts','office_admin','it_manager')
    )
  );

-- Delete: admin, manager only
CREATE POLICY "asset_docs_delete" ON asset_documents
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
        AND u.role IN ('admin','manager')
    )
  );

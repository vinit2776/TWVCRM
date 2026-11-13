-- Asset purchase invoices: mark which asset_documents rows are invoices, and tie together
-- the rows created from one upload (one invoice can cover several assets, each asset
-- gets its own row pointing at the same file).
ALTER TABLE asset_documents
  ADD COLUMN IF NOT EXISTS doc_kind TEXT,
  ADD COLUMN IF NOT EXISTS invoice_group_id UUID;

ALTER TABLE asset_documents
  DROP CONSTRAINT IF EXISTS asset_documents_doc_kind_check;
ALTER TABLE asset_documents
  ADD CONSTRAINT asset_documents_doc_kind_check CHECK (doc_kind IS NULL OR doc_kind = 'invoice');

CREATE INDEX IF NOT EXISTS idx_asset_documents_invoice_group
  ON asset_documents (invoice_group_id) WHERE invoice_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_documents_invoices
  ON asset_documents (asset_id) WHERE doc_kind = 'invoice';

-- Rollback:
--   DROP INDEX IF EXISTS idx_asset_documents_invoices;
--   DROP INDEX IF EXISTS idx_asset_documents_invoice_group;
--   ALTER TABLE asset_documents DROP CONSTRAINT IF EXISTS asset_documents_doc_kind_check;
--   ALTER TABLE asset_documents DROP COLUMN IF EXISTS invoice_group_id, DROP COLUMN IF EXISTS doc_kind;

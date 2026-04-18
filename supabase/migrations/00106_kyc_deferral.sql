-- KYC Deferral: admins/managers can temporarily defer a document requirement
-- to unblock contract activation. The requirement is NOT waived — it remains
-- visible everywhere and must be fulfilled for full compliance.
ALTER TABLE contract_documents
  ADD COLUMN IF NOT EXISTS deferred_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS deferred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deferred_reason TEXT,
  ADD COLUMN IF NOT EXISTS deferred_until DATE;

COMMENT ON COLUMN contract_documents.status IS
  'pending | uploaded | approved | rejected | deferred';
COMMENT ON COLUMN contract_documents.deferred_reason IS
  'Required when status=deferred. Records why the document was temporarily bypassed.';
COMMENT ON COLUMN contract_documents.deferred_until IS
  'Optional deadline by which the deferred document must be collected.';

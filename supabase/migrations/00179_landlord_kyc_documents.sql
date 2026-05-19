-- Migration: add kyc_documents JSONB column to landlords
-- Each element: { name, doc_type, path, uploaded_at }
-- doc_type values: pan_card | gstin_certificate | aadhaar | cancelled_cheque | other

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS kyc_documents JSONB NOT NULL DEFAULT '[]';

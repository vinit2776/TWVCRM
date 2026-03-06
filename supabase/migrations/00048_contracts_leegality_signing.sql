-- Add Leegality e-stamp / e-sign fields to contracts (membership agreements)
-- These mirror the same fields already present on case_agreements for L&L agreements.

ALTER TABLE contracts
  ADD COLUMN leegality_document_id  VARCHAR(255),
  ADD COLUMN leegality_sign_url     TEXT,
  ADD COLUMN leegality_status       VARCHAR(50),
  ADD COLUMN signed_at              TIMESTAMPTZ;

CREATE INDEX idx_contracts_leegality_doc ON contracts(leegality_document_id)
  WHERE leegality_document_id IS NOT NULL;

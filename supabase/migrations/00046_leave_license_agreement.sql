-- Migration: Add Leave & License agreement support
-- Adds type discriminator to case_agreements, Leegality fields, and L&L tracking on cases

-- 1. Add type column to distinguish proposal vs leave & license agreement
ALTER TABLE case_agreements ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'proposal';

-- 2. Add Leegality e-signing/e-stamping fields
ALTER TABLE case_agreements
  ADD COLUMN IF NOT EXISTS leegality_document_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS leegality_sign_url TEXT,
  ADD COLUMN IF NOT EXISTS leegality_status VARCHAR(50),
  ADD COLUMN IF NOT EXISTS leegality_estamp_value DECIMAL(12,2);

-- 3. Add L&L agreement reference columns to cases table
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS ll_agreement_id UUID REFERENCES case_agreements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ll_agreement_status agreement_status;

-- 4. Backfill existing records as proposals
UPDATE case_agreements SET type = 'proposal' WHERE type = 'proposal' OR type IS NULL;

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_agreements_type ON case_agreements(type);
CREATE INDEX IF NOT EXISTS idx_cases_ll_agreement ON cases(ll_agreement_id) WHERE ll_agreement_id IS NOT NULL;

-- ==========================================
-- 00024: Procurement Enhancements
-- Adds approval_code to purchase_requests for unique verification reference
-- ==========================================

-- Add approval_code column (nullable — only set when PR is approved)
ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS approval_code VARCHAR(20) UNIQUE;

-- Index for fast lookup by approval code (audit/verification use case)
CREATE INDEX IF NOT EXISTS idx_purchase_requests_approval_code
  ON purchase_requests(approval_code);

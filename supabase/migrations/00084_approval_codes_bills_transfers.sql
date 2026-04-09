-- ==========================================
-- Migration 00084: Add approval_code to vendor_bills and stock_transfers
-- ==========================================
-- Extends signed approval codes to bill and transfer approvals
-- for unified verification across all procurement approvals.
-- ==========================================

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS approval_code VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_vendor_bills_approval_code
  ON vendor_bills(approval_code);

ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS approval_code VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_approval_code
  ON stock_transfers(approval_code);

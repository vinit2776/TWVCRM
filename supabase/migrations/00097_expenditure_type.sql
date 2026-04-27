-- ============================================================
-- Migration 00097: Expenditure type on purchase_requests
-- ============================================================

-- Add expenditure_type column: 'operational' (default) or 'amc'
ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS expenditure_type TEXT NOT NULL DEFAULT 'operational'
    CHECK (expenditure_type IN ('operational', 'amc'));

-- Backfill existing rows
UPDATE purchase_requests SET expenditure_type = 'operational' WHERE expenditure_type IS NULL;

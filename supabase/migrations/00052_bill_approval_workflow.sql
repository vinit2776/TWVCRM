-- Invoice approval workflow: adds approval gate between invoice upload and payment

-- 1. Add invoice_approved value to po_status enum
ALTER TYPE po_status ADD VALUE IF NOT EXISTS 'invoice_approved';

-- 2. Add approval columns to vendor_bills
ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS approval_status    TEXT DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approved_by        UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason   TEXT,
  ADD COLUMN IF NOT EXISTS rejection_outcome  TEXT
    CHECK (rejection_outcome IS NULL OR rejection_outcome IN ('return', 'replacement', 'void'));

-- 3. Index for filtering bills by approval status
CREATE INDEX IF NOT EXISTS idx_vendor_bills_approval_status
  ON vendor_bills(approval_status);

-- 4. Backfill: mark all existing bills as approved so they are not retroactively blocked
UPDATE vendor_bills
SET approval_status = 'approved',
    approved_at     = created_at
WHERE approval_status = 'pending';

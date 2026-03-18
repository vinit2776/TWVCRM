-- Migration 00057: Add "build_approved" status and approval metadata to support_tickets

-- 1. Drop the existing status check constraint (name may vary; use DO block for safety)
DO $$
BEGIN
  ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS support_tickets_status_check;
EXCEPTION WHEN others THEN NULL;
END $$;

-- 2. Re-add the constraint with the new status value
ALTER TABLE support_tickets
  ADD CONSTRAINT support_tickets_status_check
  CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'build_approved'));

-- 3. Add approval metadata columns
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS build_approved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS build_approved_by    UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS build_approved_notes TEXT;

-- 4. Index for quick lookups of approved-for-build tickets
CREATE INDEX IF NOT EXISTS idx_support_tickets_build_approved
  ON support_tickets(status)
  WHERE status = 'build_approved';

-- Add approval_mode to property_leases
-- manual: every payment requires admin approval before it goes to Acc Payables
-- blanket: payments are auto-approved on generation; admin can still hold individual ones

ALTER TABLE property_leases
  ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (approval_mode IN ('manual', 'blanket'));

-- Separate admin approval from payment recording on lease_payments
-- approved_by / approved_at track who approved (admin)
-- paid_date / payment_reference track when accounts processed the bank transfer
-- These columns already exist from migration 00177; this is a no-op if already present
DO $$ BEGIN
  ALTER TABLE lease_payments ADD COLUMN IF NOT EXISTS admin_approved_by UUID REFERENCES users(id);
  ALTER TABLE lease_payments ADD COLUMN IF NOT EXISTS admin_approved_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

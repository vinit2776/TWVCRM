-- Add rejection_reason to proposals for tracking why a proposal was rejected
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

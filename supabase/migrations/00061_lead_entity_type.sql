-- Add entity_type to leads for customer profile / KYC planning
ALTER TABLE leads ADD COLUMN IF NOT EXISTS entity_type TEXT;

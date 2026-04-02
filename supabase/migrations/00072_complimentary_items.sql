-- Structured complimentary services as line items (replaces free-text description)
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS complimentary_items JSONB DEFAULT '[]';
-- Also add to contracts for inheritance
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS complimentary_items JSONB DEFAULT '[]';

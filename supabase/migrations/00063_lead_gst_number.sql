-- Add GST number to leads for customer GSTIN tracking
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gst_number VARCHAR(20);

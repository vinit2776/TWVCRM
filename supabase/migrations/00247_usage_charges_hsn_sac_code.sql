-- Add hsn_sac_code column to usage_charges so that ad-hoc charges
-- can carry the correct SAC code when billed on a GST invoice.
-- Default 999799 = "Other miscellaneous services" (generic fallback).
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS hsn_sac_code VARCHAR(20) DEFAULT '999799';

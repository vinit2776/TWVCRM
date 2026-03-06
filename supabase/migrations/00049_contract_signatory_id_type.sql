-- Add ID type field to distinguish between PAN and Aadhaar for the member signatory
-- The existing member_signatory_pan column stores the actual ID number value
-- (field name is kept for backward compat; the value may be PAN or Aadhaar)
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS member_signatory_id_type VARCHAR(10) DEFAULT 'pan';

-- All existing rows default to 'pan' (backward compatible)

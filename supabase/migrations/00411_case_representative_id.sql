-- PAN/Aadhaar of the authorized representative signing on the client's behalf
-- for a VO case (mirrors contracts.member_signatory_id_type / member_signatory_pan).
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS represented_by_id_type VARCHAR(10),
  ADD COLUMN IF NOT EXISTS represented_by_id_number VARCHAR(20);

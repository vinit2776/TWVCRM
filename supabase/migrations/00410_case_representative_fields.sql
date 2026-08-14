-- Authorized representative signing on the client's behalf for a VO case
-- (e.g. the Director/Partner/Proprietor named in the Leave & License agreement).
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS represented_by_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS represented_by_designation VARCHAR(100);

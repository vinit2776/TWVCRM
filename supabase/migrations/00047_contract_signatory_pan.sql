-- Add personal PAN of the authorised signatory to contracts
-- This is distinct from the company PAN (stored on the lead) and is required
-- for KYC and for naming the representative in the membership agreement preamble.

ALTER TABLE contracts ADD COLUMN member_signatory_pan VARCHAR(20);

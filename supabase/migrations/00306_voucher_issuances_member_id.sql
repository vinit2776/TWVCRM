-- Add member_id to voucher_issuances so issuances can be linked to a named
-- contract member. Nullable so existing rows (issued before this migration)
-- remain valid without any backfill.

ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES contract_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_voucher_issuances_member_id ON voucher_issuances(member_id);

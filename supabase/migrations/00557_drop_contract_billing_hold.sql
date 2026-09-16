-- Reverts 00556_contract_billing_hold.sql. Course-corrected before that
-- feature shipped: a billing hold needs to scope to one specific charge
-- (see 00558_usage_charge_hold.sql), not pause an entire contract's
-- billing — a contract can have some charges that are fine to bill and
-- one that genuinely needs review. Left as a follow-up migration rather
-- than editing 00556 in place, since 00556 was already applied to at
-- least one environment before this correction — rewriting an applied
-- migration's contents in place would desync its checksum from what
-- actually ran there.
DROP INDEX IF EXISTS idx_contracts_billing_hold;

ALTER TABLE contracts
  DROP COLUMN IF EXISTS billing_hold_at,
  DROP COLUMN IF EXISTS billing_hold_by,
  DROP COLUMN IF EXISTS billing_hold_reason;

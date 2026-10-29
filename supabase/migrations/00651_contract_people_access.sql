-- Contract people & access: one person record per contract, with what each
-- person is meant to get (WiFi voucher, door access) tracked separately from
-- whether it has been issued yet.
--
-- Until now, adding a member immediately provisioned door access and texted an
-- enrollment PIN, and a contact added by sales never became a member. These
-- columns let a person be added first (by sales or IT) and have access issued
-- afterwards (normally by IT), with the contract showing what is still pending.
--
-- Purely additive: existing members keep needs_voucher/needs_door = true, which
-- matches what they already received, so nothing about them changes.
--
-- Rollback:
--   ALTER TABLE contract_members
--     DROP COLUMN IF EXISTS needs_voucher,
--     DROP COLUMN IF EXISTS needs_door,
--     DROP COLUMN IF EXISTS left_on,
--     DROP COLUMN IF EXISTS left_reason,
--     DROP COLUMN IF EXISTS added_by;

ALTER TABLE contract_members
  ADD COLUMN IF NOT EXISTS needs_voucher boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS needs_door    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS left_on       date,
  ADD COLUMN IF NOT EXISTS left_reason   text,
  ADD COLUMN IF NOT EXISTS added_by      uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN contract_members.needs_voucher IS
  'This person should receive a WiFi voucher. Issued state lives in voucher_issuances.member_id.';
COMMENT ON COLUMN contract_members.needs_door IS
  'This person should receive door access. Issued state lives in cosec_access_users (user_type = member).';
COMMENT ON COLUMN contract_members.left_on IS
  'Date the person left; set together with is_active = false. The row is kept as history.';

-- Rent waiver kind.
--
-- A contract_rent_waivers row (00575) only says a missed rent month "won't be
-- billed through the CRM". That covers two very different things: rent that was
-- collected outside the CRM (most of the months before rent billing moved in,
-- June 2026) and rent the customer was deliberately not charged (a real
-- concession). The Value tab's Money view could not tell them apart, so it had
-- to leave every waiver out of "concessions given".
--
-- waiver_kind records which one it is. New waivers must choose; every row that
-- exists today reads 'unknown' and stays out of the concession total until it
-- is classified.
--
-- No RLS change (the table already has its SELECT policy; writes go through the
-- admin-only routes with the service role).
--
-- Rollback: ALTER TABLE contract_rent_waivers DROP COLUMN waiver_kind;

ALTER TABLE contract_rent_waivers
  ADD COLUMN IF NOT EXISTS waiver_kind text NOT NULL DEFAULT 'unknown'
  CONSTRAINT contract_rent_waivers_kind_check
    CHECK (waiver_kind IN ('giveaway', 'billed_elsewhere', 'unknown'));

COMMENT ON COLUMN contract_rent_waivers.waiver_kind IS
  'giveaway = the customer was deliberately not charged (a concession); billed_elsewhere = rent was collected outside the CRM; unknown = made before this column existed and not yet classified.';

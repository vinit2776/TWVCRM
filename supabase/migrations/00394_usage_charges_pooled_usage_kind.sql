-- Extend booking_charge_kind to allow the new unified "pooled monthly usage"
-- charge type (Model B billing redesign).
--
-- 'quota_overage' and 'overtime' are kept valid forever — historical rows
-- already use them and must remain valid. Only NEW rows, going forward,
-- use 'pooled_usage'. This migration is purely additive: no existing row
-- is touched, and old application code paths keep writing the old values
-- exactly as before until the checkout logic is switched over in a later,
-- separate change.
ALTER TABLE usage_charges
  DROP CONSTRAINT IF EXISTS usage_charges_booking_charge_kind_check;

ALTER TABLE usage_charges
  ADD CONSTRAINT usage_charges_booking_charge_kind_check
    CHECK (booking_charge_kind IN ('quota_overage', 'overtime', 'pooled_usage'));

-- Migration: 00211_unifi_voucher_tracking
-- Adds UniFi API integration support for Nungambakkam LGF.
-- All other locations continue using the existing import-based voucher stack.
-- Purely additive — no existing columns modified.

-- 1. Add unifi_site_id to locations so we know which locations are UniFi-managed
ALTER TABLE locations ADD COLUMN IF NOT EXISTS unifi_site_id TEXT;

COMMENT ON COLUMN locations.unifi_site_id IS
  'UniFi site _id for this location. When set, vouchers are issued via the UniFi API '
  '(precision duration + auto-revoke on cancel). NULL = use legacy import-based stack.';

-- 2. Track the UniFi voucher ID on contracts so we can revoke on cancellation
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS unifi_voucher_id TEXT;

COMMENT ON COLUMN contracts.unifi_voucher_id IS
  'UniFi _id of the active voucher issued for this contract. '
  'Used to revoke internet access immediately on contract cancellation.';

-- 3. Track the UniFi voucher ID on bookings for the same reason
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unifi_voucher_id TEXT;

COMMENT ON COLUMN bookings.unifi_voucher_id IS
  'UniFi _id of the voucher issued for this booking session. '
  'Voucher duration matches exact booking window.';

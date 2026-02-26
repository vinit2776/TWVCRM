-- Widen validity_days from INTEGER to NUMERIC(10,4) to support sub-day durations
-- e.g. 3 hours = 0.125 days. All existing integer values (1, 7, 30, 90 …) are preserved exactly.
ALTER TABLE voucher_repository
  ALTER COLUMN validity_days TYPE NUMERIC(10, 4);

-- DATA MIGRATION: Reclassify existing unclassified vouchers as 3-hour vouchers.
-- Run this only after confirming all currently-unclassified vouchers are 3-hour WiFi vouchers.
-- UPDATE voucher_repository SET validity_days = 0.125 WHERE validity_days IS NULL;

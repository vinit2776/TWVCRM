-- Migration: 00212_voucher_issuances_unifi_nullable
--
-- Unifi live-API issuances don't have a voucher_repository row —
-- they are generated on-demand. Make voucher_id nullable so these
-- rows can be stored in voucher_issuances alongside import-based ones.
--
-- The UNIQUE(voucher_id) constraint is fine with multiple NULLs
-- (Postgres treats NULLs as distinct), so no change needed there.

ALTER TABLE voucher_issuances ALTER COLUMN voucher_id DROP NOT NULL;

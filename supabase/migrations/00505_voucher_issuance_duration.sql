-- voucher_issuances has no record of how long an issued WiFi voucher was
-- actually valid for. valid_from/valid_until are dates only (both equal the
-- booking date for on-demand booking vouchers), so they can't express a
-- 2-hour or 10-hour validity window — nobody could see what was actually
-- issued after the fact.
--
-- duration_minutes is nullable because existing rows genuinely have no
-- recorded duration; it's populated going forward for new issuances (Unifi:
-- computed booking-window minutes + 60min buffer; Ruijie: derived from the
-- matched CRM_ package's actual expiry; repository: validity_days * 24 * 60).
--
-- No RLS policy is added here — voucher_issuances already has RLS enabled
-- (see supabase/migrations for its original CREATE TABLE) and this only adds
-- a column to an existing table.
ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS duration_minutes integer;

COMMENT ON COLUMN voucher_issuances.duration_minutes IS
  'Voucher validity in minutes at time of issuance. Nullable — not recorded for issuances created before this column existed.';

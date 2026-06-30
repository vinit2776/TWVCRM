-- Store the human-readable UniFi voucher code on issuances.
-- Previously only unifi_voucher_id (internal _id) was stored; the code was
-- returned by createUnifiVoucher() but discarded, causing blank codes in emails.

ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS unifi_code TEXT;

COMMENT ON COLUMN voucher_issuances.unifi_code IS
  'Human-readable UniFi voucher code (e.g. "1234-5678"). Populated for UniFi-managed locations. Distinct from unifi_voucher_id which is the internal UniFi _id.';

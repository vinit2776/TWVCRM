-- 00659_normalize_lead_phone_numbers.sql
-- Brings saved phone numbers to one format: an Indian number as its 10 digits ("9876543210").
-- New numbers are normalised on save (src/lib/phone.ts); this fixes the ones already stored
-- ("98765 43210", "+91-98765-43210", "09876543210"). It only strips punctuation, a +91/91
-- prefix or a leading STD 0. Anything that does not come out as exactly 10 digits (foreign,
-- landline, malformed) is left exactly as it was.

CREATE OR REPLACE FUNCTION normalize_stored_phone(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN length(d) = 12 AND d LIKE '91%' THEN substr(d, 3)
    WHEN length(d) = 11 AND d LIKE '0%'  THEN substr(d, 2)
    WHEN length(d) = 10                  THEN d
    ELSE p
  END
  FROM (SELECT regexp_replace(p, '\D', '', 'g') AS d) s;
$$;

UPDATE leads
SET phone = normalize_stored_phone(phone)
WHERE phone IS NOT NULL AND normalize_stored_phone(phone) IS DISTINCT FROM phone;

UPDATE leads
SET mobile = normalize_stored_phone(mobile)
WHERE mobile IS NOT NULL AND normalize_stored_phone(mobile) IS DISTINCT FROM mobile;

UPDATE lead_contacts
SET phone = normalize_stored_phone(phone)
WHERE phone IS NOT NULL AND normalize_stored_phone(phone) IS DISTINCT FROM phone;

UPDATE lead_contacts
SET mobile = normalize_stored_phone(mobile)
WHERE mobile IS NOT NULL AND normalize_stored_phone(mobile) IS DISTINCT FROM mobile;

-- Rollback: the original spacing and prefixes are not kept. Restore from a database backup if
-- needed; DROP FUNCTION normalize_stored_phone(text) removes only the helper.

-- 00618_whatsapp_enquiry_source.sql
-- Inbound WhatsApp messages (the number promoted in ads) now become leads and Enquiry Log
-- rows, like the Google Ads / Meta Ads / walk-in forms. They need a source value of their own.

-- Leads: new enum value. (Cannot be used in the same transaction it is added in; nothing here uses it.)
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'whatsapp';

-- Enquiries: source is a text column guarded by a CHECK (00583).
ALTER TABLE lead_enquiries DROP CONSTRAINT IF EXISTS lead_enquiries_source_check;
ALTER TABLE lead_enquiries
  ADD CONSTRAINT lead_enquiries_source_check
  CHECK (source IN ('google_ads', 'meta_ads', 'direct_walkin', 'whatsapp'));

-- Rollback:
--   ALTER TABLE lead_enquiries DROP CONSTRAINT lead_enquiries_source_check;
--   (delete or recode any source = 'whatsapp' rows first)
--   ALTER TABLE lead_enquiries ADD CONSTRAINT lead_enquiries_source_check
--     CHECK (source IN ('google_ads', 'meta_ads', 'direct_walkin'));
--   The 'whatsapp' lead_source enum value cannot be dropped; leave it unused.

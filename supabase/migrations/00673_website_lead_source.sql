-- 00673_website_lead_source.sql
-- Enquiries from the new theworkvilla.com website form get a source of their own instead of
-- being filed as "Walk-in".

-- Leads: new enum value. (Cannot be used in the same transaction it is added in; nothing here uses it.)
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'website';

-- Enquiries: source is a text column guarded by a CHECK (00583, widened in 00618).
ALTER TABLE lead_enquiries DROP CONSTRAINT IF EXISTS lead_enquiries_source_check;
ALTER TABLE lead_enquiries
  ADD CONSTRAINT lead_enquiries_source_check
  CHECK (source IN ('google_ads', 'meta_ads', 'direct_walkin', 'whatsapp', 'website'));

-- Rollback:
--   (recode any lead_enquiries.source = 'website' rows first)
--   ALTER TABLE lead_enquiries DROP CONSTRAINT lead_enquiries_source_check;
--   ALTER TABLE lead_enquiries ADD CONSTRAINT lead_enquiries_source_check
--     CHECK (source IN ('google_ads', 'meta_ads', 'direct_walkin', 'whatsapp'));
--   The 'website' lead_source enum value cannot be dropped; leave it unused.

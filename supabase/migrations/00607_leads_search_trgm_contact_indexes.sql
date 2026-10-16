-- Global search (Cmd+K) matches leads with one OR across six columns:
--   first_name, last_name, email, phone, mobile, company  (ILIKE '%term%')
-- 00151 indexed first_name, last_name and company only. Postgres can use a BitmapOr only
-- when EVERY branch of the OR has an index, so with email/phone/mobile unindexed the whole
-- query fell back to a sequential scan of leads. These three complete the set.
--
-- Rollback: DROP INDEX IF EXISTS idx_leads_email_trgm, idx_leads_phone_trgm, idx_leads_mobile_trgm;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_leads_email_trgm
  ON leads USING gin (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_leads_phone_trgm
  ON leads USING gin (phone gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_leads_mobile_trgm
  ON leads USING gin (mobile gin_trgm_ops);

-- pg_trgm GIN indexes for booking search (Wave 3, item 3.6)
--
-- The booking list search uses ILIKE on 5 columns. Without indexes,
-- each query triggers sequential scans. pg_trgm GIN indexes let
-- PostgreSQL use the index for %pattern% ILIKE queries.
--
-- Also covers lead name search (pre-query in the bookings endpoint).

-- Enable the extension (already available on Supabase, just needs activation)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Booking search columns
CREATE INDEX IF NOT EXISTS idx_bookings_number_trgm
  ON bookings USING gin (booking_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bookings_guest_name_trgm
  ON bookings USING gin (guest_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bookings_guest_phone_trgm
  ON bookings USING gin (guest_phone gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bookings_guest_company_trgm
  ON bookings USING gin (guest_company gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bookings_booker_phone_trgm
  ON bookings USING gin (booker_phone gin_trgm_ops);

-- Lead search columns (used by the pre-query in bookings search)
CREATE INDEX IF NOT EXISTS idx_leads_first_name_trgm
  ON leads USING gin (first_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_leads_last_name_trgm
  ON leads USING gin (last_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_leads_company_trgm
  ON leads USING gin (company gin_trgm_ops);

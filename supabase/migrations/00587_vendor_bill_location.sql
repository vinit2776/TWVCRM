-- Vendor bills: which location (and connection) an electricity bill is for (Phase 2, PR B1)
--
-- Additive. Four nullable columns on vendor_bills; nothing is backfilled and every
-- existing bill is untouched. They are only ever written for bills from a vendor
-- marked as an electricity provider (see 00586), so the form and API for every other
-- vendor never reference them.
--
--   location_id                  the location the bill is for, chosen by the person
--                                recording it (never inferred from the bill's wording)
--   connection_id                the utility connection, when it could be identified
--                                from the consumer number / a remembered name, or is
--                                the only one at that location
--   electricity_consumer_number  the consumer number as typed from the bill
--   electricity_printed_name     the site/tenant wording as printed on the bill
--
-- The last two are kept so the details form (PR B2) can pre-fill them and so a
-- later "remember this name" can be audited back to the bill that taught it.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_vendor_bills_connection; DROP INDEX IF EXISTS idx_vendor_bills_location;
--   ALTER TABLE vendor_bills DROP COLUMN IF EXISTS electricity_printed_name,
--     DROP COLUMN IF EXISTS electricity_consumer_number, DROP COLUMN IF EXISTS connection_id,
--     DROP COLUMN IF EXISTS location_id;

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS location_id                 UUID REFERENCES locations(id),
  ADD COLUMN IF NOT EXISTS connection_id               UUID REFERENCES location_electricity_connections(id),
  ADD COLUMN IF NOT EXISTS electricity_consumer_number TEXT,
  ADD COLUMN IF NOT EXISTS electricity_printed_name    TEXT;

CREATE INDEX IF NOT EXISTS idx_vendor_bills_location
  ON vendor_bills(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_bills_connection
  ON vendor_bills(connection_id) WHERE connection_id IS NOT NULL;

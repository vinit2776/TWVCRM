-- facility_catalog was redundant — location_services already provides
-- the same per-location catalogue (name, unit, price_per_unit).
-- ContractFacilitiesSection now reads quick-picks from location_services.
DROP TABLE IF EXISTS facility_catalog;

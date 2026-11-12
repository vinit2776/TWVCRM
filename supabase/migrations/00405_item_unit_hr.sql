-- Add 'hr' (hour) to the item_unit enum. It was already present in the
-- ItemUnit TS type/ITEM_UNITS constant (for manpower/OT hourly items) but the
-- enum value itself was never migrated, so inserts failed with
-- "invalid input value for enum item_unit: hr".

ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'hr';  -- hour (manpower/OT items)

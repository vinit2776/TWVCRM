-- Expand the item_unit enum so procurement (catalog / material requests / POs)
-- can express civil-interior work, AMC service contracts and pantry packaging.
--
-- Two things prompted this:
--   1. 'sqft' and the rest of 00111's construction units were added to the DB
--      enum but never to the ITEM_UNITS TS constant, so they were unreachable
--      from the UI. This migration is idempotent, so re-listing them is safe
--      whether or not 00111 landed on this database.
--   2. 'lumpsum' is needed for quoted work with no natural unit (civil jobs,
--      AMC fees, one-off service charges).

-- Area / linear / cubic (re-asserting 00111 defensively)
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'sqft';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'sqm';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'rft';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'rmt';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'cft';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'cbm';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'metre';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'feet';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'inch';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'bundle';

-- Count & discrete
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'sheet';     -- plywood, laminate, acrylic
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'ream';      -- A4 / printer paper

-- Packaging
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'sachet';    -- tea / coffee / sugar sachets
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'carton';    -- milk, bulk pantry
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'tin';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'tube';      -- sealant, adhesive
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'drum';      -- housekeeping chemicals
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'cylinder';  -- pantry LPG

-- Weight & volume
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'gram';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'ml';

-- Length
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'km';        -- transport / logistics

-- Time & service
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'day';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'manday';    -- labour contracts
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'visit';     -- AMC / pest control call-outs

-- Other
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'lumpsum';   -- quoted work, no natural unit
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'kwh';       -- electricity / DG consumption

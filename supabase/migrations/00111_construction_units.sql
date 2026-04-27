-- Add construction/dimensional units to item_unit enum for procurement module.
-- Needed for civil/interior work items: tiles, paint, steel, wood, etc.

ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'sqft';    -- square feet (area)
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'sqm';     -- square metre (area)
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'rft';     -- running feet (linear)
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'rmt';     -- running metre (linear)
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'cft';     -- cubic feet (volume)
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'cbm';     -- cubic metre (volume)
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'metre';   -- length in metres
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'feet';    -- length in feet
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'inch';    -- length in inches
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'bundle';  -- rebar, cables, rods

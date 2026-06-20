-- Simplify facility_asset_categories to 6 top-level groups:
-- HVAC, IT, Furniture, Electrical, Equipment, Others
--
-- Strategy:
--   1. Insert the 6 new canonical categories (idempotent via ON CONFLICT slug).
--   2. Remap every facility_asset pointing to an old sub-category to its
--      new parent group.
--   3. Delete the old sub-categories that are no longer referenced.

-- ── 1. Insert / upsert the 6 canonical categories ────────────────────────────
INSERT INTO facility_asset_categories
  (scope, name, slug, icon, description,
   default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs,
   sort_order)
VALUES
  ('hvac',       'HVAC',        'group-hvac',      'Wind',         'Air conditioning, ventilation, exhaust, heating systems', 2, 8, 24, 72,  10),
  ('it',         'IT',          'group-it',         'Server',       'Networking, servers, access points, IT hardware',         1, 4, 12, 48,  20),
  ('facility',   'Furniture',   'group-furniture',  'Armchair',     'Desks, chairs, sofas, cabinets, partitions',              8, 24, 72, 168, 30),
  ('electrical', 'Electrical',  'group-electrical', 'Zap',          'Power, lighting, MCBs, UPS, generators, wiring',          2, 8, 24, 72,  40),
  ('facility',   'Equipment',   'group-equipment',  'Package',      'Machinery, appliances, security, plumbing equipment',     4, 12, 48, 96,  50),
  ('facility',   'Others',      'group-others',     'HelpCircle',   'Anything not covered by the above categories',            8, 24, 72, 168, 60)
ON CONFLICT (slug) DO UPDATE SET
  scope       = EXCLUDED.scope,
  name        = EXCLUDED.name,
  icon        = EXCLUDED.icon,
  description = EXCLUDED.description,
  sort_order  = EXCLUDED.sort_order;

-- ── 2. Remap assets from old sub-categories to new groups ─────────────────────
-- HVAC group: AC, exhaust fan, water heater
UPDATE facility_assets
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-hvac')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE slug IN ('hvac-ac', 'hvac-exhaust', 'hvac-geyser')
);

-- IT group: all existing IT-scope categories
UPDATE facility_assets
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-it')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories WHERE scope = 'it' AND slug != 'group-it'
);

-- Furniture group: furniture sub-category
UPDATE facility_assets
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-furniture')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories WHERE slug = 'hk-furniture'
);

-- Electrical group: all electrical sub-categories
UPDATE facility_assets
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-electrical')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE scope = 'electrical' AND slug != 'group-electrical'
);

-- Equipment group: plumbing + security + elevator + parking
UPDATE facility_assets
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-equipment')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE scope IN ('plumbing', 'security')
     OR slug IN ('other-elevator', 'other-parking')
);

-- Others group: remaining housekeeping + general other
UPDATE facility_assets
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-others')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE slug IN ('hk-glass', 'hk-floor', 'hk-door', 'hk-signage', 'hk-pest', 'other-general')
);

-- ── 3. Delete old sub-categories that are no longer referenced ────────────────
DELETE FROM facility_asset_categories
WHERE slug NOT LIKE 'group-%'
  AND NOT EXISTS (
    SELECT 1 FROM facility_assets WHERE category_id = facility_asset_categories.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM facility_issues WHERE category_id = facility_asset_categories.id
  );

-- Force-consolidate all old sub-categories into the 6 canonical group categories.
-- 00289 did assets but skipped categories still referenced by facility_issues.
-- This migration remaps issues too, then hard-deletes all non-group-* categories.

-- ── 1. Remap facility_issues referencing old IT sub-categories → group-it ─────
UPDATE facility_issues
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-it')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE scope = 'it' AND slug != 'group-it'
);

-- ── 2. Remap issues referencing old HVAC sub-categories → group-hvac ──────────
UPDATE facility_issues
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-hvac')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE slug IN ('hvac-ac', 'hvac-exhaust', 'hvac-geyser')
);

-- ── 3. Remap issues referencing old electrical sub-categories → group-electrical
UPDATE facility_issues
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-electrical')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE scope = 'electrical' AND slug != 'group-electrical'
);

-- ── 4. Remap issues referencing furniture → group-furniture ───────────────────
UPDATE facility_issues
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-furniture')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories WHERE slug = 'hk-furniture'
);

-- ── 5. Remap issues referencing plumbing/security/elevator/parking → group-equipment
UPDATE facility_issues
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-equipment')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE scope IN ('plumbing', 'security')
     OR slug IN ('other-elevator', 'other-parking')
);

-- ── 6. Remap all remaining old categories (housekeeping, general other) → group-others
UPDATE facility_issues
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-others')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE slug NOT LIKE 'group-%'
);

-- ── 7. Remap any remaining facility_assets still on old categories (safety net) ──
UPDATE facility_assets
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-it')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE scope = 'it' AND slug != 'group-it'
);

UPDATE facility_assets
SET category_id = (SELECT id FROM facility_asset_categories WHERE slug = 'group-others')
WHERE category_id IN (
  SELECT id FROM facility_asset_categories
  WHERE slug NOT LIKE 'group-%'
);

-- ── 8. Hard-delete all non-canonical categories ───────────────────────────────
DELETE FROM facility_asset_categories
WHERE slug NOT LIKE 'group-%';

-- ============================================================
-- 00266: Facility Assets — Lifecycle & Category Extensions
--
-- Phase 1 of the facility asset lifecycle project:
--   1. Add custom_field_schema JSONB to facility_asset_categories
--      (each category defines its own fields — AC gets capacity, type, etc.)
--   2. Add lifecycle columns to facility_assets
--      (lifecycle_stage, installation_date, t_and_c_*, custom_field_values,
--       procurement_po_id soft ref)
--   3. Seed the AC category under 'hvac' scope
--   4. Add fms role to asset write RLS
--
-- Purely additive — no existing columns or data are modified.
-- ============================================================

-- ---------------------------------------------------------------------------
-- 1. Lifecycle stage enum
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE facility_lifecycle_stage AS ENUM (
    'procured',           -- PO placed / asset received
    'installed',          -- physically installed at location
    'testing_commissioning', -- T&C in progress
    'operational',        -- running, in service
    'under_amc',          -- covered by AMC contract
    'decommissioned'      -- retired / removed from service
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. Extend facility_asset_categories
-- ---------------------------------------------------------------------------

ALTER TABLE facility_asset_categories
  ADD COLUMN IF NOT EXISTS custom_field_schema JSONB DEFAULT '[]'::JSONB;

COMMENT ON COLUMN facility_asset_categories.custom_field_schema IS
  'JSON array of {key, label, type, required, options?} defining category-specific fields';

-- ---------------------------------------------------------------------------
-- 3. Extend facility_assets with lifecycle columns
-- ---------------------------------------------------------------------------

ALTER TABLE facility_assets
  ADD COLUMN IF NOT EXISTS lifecycle_stage facility_lifecycle_stage DEFAULT 'operational',
  ADD COLUMN IF NOT EXISTS installation_date DATE,
  ADD COLUMN IF NOT EXISTS commissioned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS commissioned_by UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS custom_field_values JSONB DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS procurement_po_id UUID;

COMMENT ON COLUMN facility_assets.procurement_po_id IS
  'Soft reference to purchase_orders.id — not a FK because assets can exist without a PO (legacy assets)';

COMMENT ON COLUMN facility_assets.custom_field_values IS
  'Key-value pairs matching the category custom_field_schema keys';

-- Index on lifecycle_stage for filtering
CREATE INDEX IF NOT EXISTS idx_facility_assets_lifecycle
  ON facility_assets(lifecycle_stage);

-- ---------------------------------------------------------------------------
-- 4. Seed AC category (hvac scope)
-- ---------------------------------------------------------------------------

INSERT INTO facility_asset_categories
  (scope, name, slug, icon, description,
   default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs,
   sort_order, custom_field_schema)
VALUES
  ('hvac', 'Air Conditioner', 'hvac-ac', 'Snowflake', 'Split, cassette, VRF, and window AC units',
   2, 8, 24, 72, 10,
   '[
     {"key": "ac_type", "label": "AC Type", "type": "select", "required": true, "options": ["Split", "Cassette", "VRF", "Window", "Ductable", "Tower"]},
     {"key": "capacity_tons", "label": "Capacity (tons)", "type": "number", "required": true},
     {"key": "refrigerant_type", "label": "Refrigerant", "type": "select", "required": false, "options": ["R-22", "R-32", "R-410A", "R-134a", "Other"]},
     {"key": "power_rating_kw", "label": "Power Rating (kW)", "type": "number", "required": false},
     {"key": "indoor_unit_model", "label": "Indoor Unit Model", "type": "text", "required": false},
     {"key": "outdoor_unit_model", "label": "Outdoor Unit Model", "type": "text", "required": false}
   ]'::JSONB)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Update RLS — add fms role to asset write policy
--    (FMS team needs to register and update assets, not just IT)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "fac_assets_write" ON facility_assets;

CREATE POLICY "fac_assets_write" ON facility_assets
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'it_technician', 'fms')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'it_technician', 'fms')
        AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Update category write RLS — add fms + manager roles
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "fac_cat_write" ON facility_asset_categories;

CREATE POLICY "fac_cat_write" ON facility_asset_categories
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'fms')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'fms')
        AND is_active = true
    )
  );

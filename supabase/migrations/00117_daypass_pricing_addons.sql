-- ============================================================
-- 00117: Day-pass pricing model + booking add-ons
--
-- Problem the migration solves:
--   • spaces only had `hourly_rate`, so day-pass spaces were
--     storing the *day rate* in the hourly column. Bookings then
--     multiplied it by duration_hours, producing wrong line items
--     (TWV-B-0030 showed total_amount_with_gst = ₹3186 for a ₹354
--     booking because the GST math was multiplied by 9 hours twice).
--
-- What this adds:
--   1. spaces.pricing_model ('hourly' | 'daily') + daily_rate
--   2. bookings.pricing_model + unit_rate + quantity
--      (kept alongside duration_hours/hourly_rate for backwards-compat
--      reads — those columns now mirror the new fields for hourly,
--      and represent 1 day-unit for daily)
--   3. booking_addons table for extra charges (extended time, services)
--   4. addon_catalog table with location-aware predefined items
--      seeded with common cafe + service + extended-time items
--   5. Backfill: any space whose name contains "Daypass" / "Day Pass"
--      is set to pricing_model='daily' and daily_rate := hourly_rate
--      (then hourly_rate cleared so accidental hourly math fails loudly).
--      Bookings on those spaces are corrected the same way.
--   6. The pre-existing TWV-B-0030 fix is also captured idempotently.
-- ============================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE space_pricing_model AS ENUM ('hourly', 'daily');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_addon_type AS ENUM ('extended_time', 'service', 'food_beverage', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- spaces: pricing_model + daily_rate
-- ---------------------------------------------------------------------------

ALTER TABLE spaces
  ADD COLUMN IF NOT EXISTS pricing_model space_pricing_model NOT NULL DEFAULT 'hourly',
  ADD COLUMN IF NOT EXISTS daily_rate    NUMERIC(12,2);

-- ---------------------------------------------------------------------------
-- bookings: pricing_model snapshot + per-unit rate + quantity
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS pricing_model space_pricing_model NOT NULL DEFAULT 'hourly',
  ADD COLUMN IF NOT EXISTS unit_rate     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS quantity      NUMERIC(8,3);

-- For existing hourly bookings: mirror the legacy columns into the new ones
UPDATE bookings
   SET unit_rate = hourly_rate,
       quantity  = duration_hours,
       pricing_model = 'hourly'
 WHERE unit_rate IS NULL;

-- ---------------------------------------------------------------------------
-- booking_addons (extras: extended time, printer pages, tea, coffee, …)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS booking_addons (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  addon_catalog_id      UUID,                              -- nullable: ad-hoc items have no catalog row
  addon_type            booking_addon_type NOT NULL DEFAULT 'service',
  description           VARCHAR(255) NOT NULL,
  unit_label            VARCHAR(40),                       -- "per page", "per cup", "per hour"
  quantity              NUMERIC(8,3) NOT NULL DEFAULT 1,
  unit_price            NUMERIC(12,2) NOT NULL DEFAULT 0,  -- excluding GST
  amount                NUMERIC(12,2) NOT NULL DEFAULT 0,  -- = quantity × unit_price
  gst_rate              NUMERIC(5,2)  NOT NULL DEFAULT 18,
  gst_amount            NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_with_gst        NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes                 TEXT,
  added_by              UUID REFERENCES public.users(id),
  added_at              TIMESTAMPTZ DEFAULT NOW(),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_addons_booking ON booking_addons(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_addons_type    ON booking_addons(addon_type);

DO $$ BEGIN
  CREATE TRIGGER update_booking_addons_updated_at
    BEFORE UPDATE ON booking_addons
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE booking_addons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "booking_addons_select" ON booking_addons;
DROP POLICY IF EXISTS "booking_addons_write"  ON booking_addons;
CREATE POLICY "booking_addons_select" ON booking_addons FOR SELECT TO authenticated USING (true);
CREATE POLICY "booking_addons_write"  ON booking_addons FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- addon_catalog (predefined items staff can pick from at check-out)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS addon_catalog (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- nullable location_id = global / available everywhere
  location_id     UUID REFERENCES locations(id) ON DELETE CASCADE,
  addon_type      booking_addon_type NOT NULL DEFAULT 'service',
  name            VARCHAR(120) NOT NULL,
  description     TEXT,
  unit_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_label      VARCHAR(40),                  -- "per page", "per cup", …
  gst_rate        NUMERIC(5,2)  NOT NULL DEFAULT 18,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES public.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_addon_catalog_location ON addon_catalog(location_id);
CREATE INDEX IF NOT EXISTS idx_addon_catalog_active   ON addon_catalog(is_active);
CREATE INDEX IF NOT EXISTS idx_addon_catalog_type     ON addon_catalog(addon_type);

DO $$ BEGIN
  CREATE TRIGGER update_addon_catalog_updated_at
    BEFORE UPDATE ON addon_catalog
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE addon_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "addon_catalog_select" ON addon_catalog;
DROP POLICY IF EXISTS "addon_catalog_write"  ON addon_catalog;
CREATE POLICY "addon_catalog_select" ON addon_catalog FOR SELECT TO authenticated USING (true);
CREATE POLICY "addon_catalog_write" ON addon_catalog FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true
    )
  );

-- FK now that table exists
ALTER TABLE booking_addons
  DROP CONSTRAINT IF EXISTS booking_addons_addon_catalog_id_fkey,
  ADD  CONSTRAINT booking_addons_addon_catalog_id_fkey
       FOREIGN KEY (addon_catalog_id) REFERENCES addon_catalog(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Seed: global addon catalog (per-location items can be added later via UI)
-- ---------------------------------------------------------------------------

INSERT INTO addon_catalog (location_id, addon_type, name, description, unit_price, unit_label, gst_rate, sort_order)
VALUES
  -- Extended time
  (NULL, 'extended_time', 'Extended hour', 'Beyond centre operating hours',                100,  'per hour', 18,  10),

  -- Food & beverage
  (NULL, 'food_beverage', 'Tea',           'Cup of tea',                                     20,  'per cup',  18,  20),
  (NULL, 'food_beverage', 'Coffee',        'Cup of coffee',                                  30,  'per cup',  18,  21),
  (NULL, 'food_beverage', 'Bottled water', '500ml mineral water',                            20,  'per bottle', 18, 22),
  (NULL, 'food_beverage', 'Snack box',     'Snacks platter',                                100,  'per box',  5,   23),

  -- Services
  (NULL, 'service', 'B&W print',           'Printer — A4, black & white',                     5,  'per page', 18,  30),
  (NULL, 'service', 'Colour print',        'Printer — A4, colour',                           20,  'per page', 18,  31),
  (NULL, 'service', 'Photocopy',           'Photocopying — A4',                               5,  'per page', 18,  32),
  (NULL, 'service', 'Scan',                'Document scanning',                              10,  'per page', 18,  33),
  (NULL, 'service', 'Locker',              'Day-use locker',                                 50,  'per day',  18,  34),
  (NULL, 'service', 'Day-use printer access', 'Unlimited B&W prints for the day',           150,  'per day',  18,  35)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill: spaces named like "Daypass" → switch to daily pricing
-- ---------------------------------------------------------------------------

UPDATE spaces
   SET pricing_model = 'daily',
       daily_rate    = COALESCE(daily_rate, hourly_rate),
       hourly_rate   = 0
 WHERE pricing_model = 'hourly'
   AND (name ILIKE '%daypass%' OR name ILIKE '%day pass%');

-- ---------------------------------------------------------------------------
-- Backfill: bookings on day-pass spaces → recompute as 1 day × daily_rate
-- ---------------------------------------------------------------------------

WITH day_passes AS (
  SELECT id, daily_rate FROM spaces WHERE pricing_model = 'daily'
)
UPDATE bookings b
   SET pricing_model         = 'daily',
       unit_rate             = dp.daily_rate,
       quantity              = 1,
       hourly_rate           = dp.daily_rate,         -- legacy column = day rate
       duration_hours        = 1,                     -- legacy column = 1 day-unit
       total_amount          = dp.daily_rate,
       gst_rate              = COALESCE(b.gst_rate, 18),
       gst_amount            = ROUND(dp.daily_rate * COALESCE(b.gst_rate, 18) / 100, 2),
       total_amount_with_gst = ROUND(dp.daily_rate + (dp.daily_rate * COALESCE(b.gst_rate, 18) / 100), 2)
  FROM day_passes dp
 WHERE b.space_id = dp.id
   AND b.pricing_model <> 'daily';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT ALL ON booking_addons TO authenticated;
GRANT ALL ON addon_catalog  TO authenticated;

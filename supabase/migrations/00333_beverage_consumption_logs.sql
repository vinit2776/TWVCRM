-- beverage_logs / beverage_log_items: a pure usage tally for vending-machine
-- drink types (Tea, Espresso, Cappuccino, etc.), tracked separately from
-- procurement_items/location_stock material consumption since drinks aren't
-- purchased or stocked as discrete units — there is no "quantity on hand" of
-- a Flat White. No correction/void lifecycle (unlike consumption_logs) since
-- this is analytics-only, not tied to stock deduction or reorder alerts.

CREATE TABLE IF NOT EXISTS beverage_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  UUID        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  logged_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beverage_log_items (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  beverage_log_id  UUID        NOT NULL REFERENCES beverage_logs(id) ON DELETE CASCADE,
  drink_type       TEXT        NOT NULL CHECK (drink_type IN (
                      'tea', 'warm_milk', 'espresso', 'cappuccino',
                      'coffee_latte', 'flat_white', 'ristretto', 'milk_foam'
                    )),
  quantity         INTEGER     NOT NULL DEFAULT 1 CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_beverage_logs_location_logged_at ON beverage_logs(location_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_beverage_log_items_log_id ON beverage_log_items(beverage_log_id);

ALTER TABLE beverage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE beverage_log_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage beverage_logs" ON beverage_logs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can manage beverage_log_items" ON beverage_log_items
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT ALL ON beverage_logs TO service_role;
GRANT ALL ON beverage_log_items TO service_role;

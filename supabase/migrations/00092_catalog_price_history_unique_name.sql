-- =====================================================================
-- Migration 00092: Catalog price audit trail
-- =====================================================================
-- NOTE: A unique index on item name (lower(trim(name))) was attempted
-- but could not be applied because existing duplicates exist in the DB.
-- The UI will flag duplicates for correction.  Once all duplicates are
-- resolved, re-apply the unique index manually:
--   CREATE UNIQUE INDEX idx_procurement_items_name_unique
--     ON procurement_items (lower(trim(name)));

-- ── Price history table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS procurement_item_price_history (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID        NOT NULL REFERENCES procurement_items(id) ON DELETE CASCADE,
  old_price   NUMERIC,
  new_price   NUMERIC,
  changed_by  UUID        NOT NULL REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes       TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_price_history_item
  ON procurement_item_price_history(item_id);
CREATE INDEX IF NOT EXISTS idx_item_price_history_at
  ON procurement_item_price_history(changed_at DESC);

ALTER TABLE procurement_item_price_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON procurement_item_price_history
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT ALL ON procurement_item_price_history TO service_role;

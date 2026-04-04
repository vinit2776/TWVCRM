-- ==========================================
-- Migration 00078: Inventory, Stock Transfers & Consumption Logging
-- ==========================================

-- ── 1. Location Stock (running balance per item per location) ───────────
CREATE TABLE IF NOT EXISTS location_stock (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     UUID NOT NULL REFERENCES locations(id),
  item_id         UUID NOT NULL REFERENCES procurement_items(id),
  quantity_on_hand NUMERIC NOT NULL DEFAULT 0,
  reorder_level   NUMERIC NOT NULL DEFAULT 0,
  last_updated    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(location_id, item_id)
);

CREATE INDEX idx_location_stock_location ON location_stock(location_id);
CREATE INDEX idx_location_stock_item     ON location_stock(item_id);

CREATE TRIGGER update_location_stock_updated_at
  BEFORE UPDATE ON location_stock
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 2. Stock Transfers ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_number  VARCHAR(20) NOT NULL UNIQUE,
  from_location_id UUID NOT NULL REFERENCES locations(id),
  to_location_id   UUID NOT NULL REFERENCES locations(id),
  status           TEXT NOT NULL DEFAULT 'draft',
  initiated_by     UUID NOT NULL REFERENCES users(id),
  approved_by      UUID REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  dispatched_at    TIMESTAMPTZ,
  received_by      UUID REFERENCES users(id),
  received_at      TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT stock_transfers_different_locations CHECK (from_location_id != to_location_id)
);

CREATE INDEX idx_stock_transfers_status ON stock_transfers(status);
CREATE INDEX idx_stock_transfers_from   ON stock_transfers(from_location_id);
CREATE INDEX idx_stock_transfers_to     ON stock_transfers(to_location_id);

CREATE TRIGGER update_stock_transfers_updated_at
  BEFORE UPDATE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 3. Stock Transfer Items ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id     UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  item_id         UUID REFERENCES procurement_items(id),
  item_name       VARCHAR(255) NOT NULL,
  unit            TEXT NOT NULL,
  quantity_sent   NUMERIC NOT NULL,
  quantity_received NUMERIC DEFAULT 0,
  notes           TEXT
);

CREATE INDEX idx_stock_transfer_items_transfer ON stock_transfer_items(transfer_id);

-- ── 4. Stock Transfer Issues (discrepancy tracking) ─────────────────────
CREATE TABLE IF NOT EXISTS stock_transfer_issues (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id       UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  transfer_item_id  UUID NOT NULL REFERENCES stock_transfer_items(id) ON DELETE CASCADE,
  issue_type        TEXT NOT NULL,
  reported_quantity NUMERIC NOT NULL,
  expected_quantity NUMERIC NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  resolved_by       UUID REFERENCES users(id),
  resolved_at       TIMESTAMPTZ,
  resolution_notes  TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stock_transfer_issues_transfer ON stock_transfer_issues(transfer_id);

-- ── 5. Consumption Logs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumption_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  logged_by   UUID NOT NULL REFERENCES users(id),
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL DEFAULT 'active',
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_consumption_logs_location ON consumption_logs(location_id);
CREATE INDEX idx_consumption_logs_status   ON consumption_logs(status);

-- ── 6. Consumption Log Items ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumption_log_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumption_log_id  UUID NOT NULL REFERENCES consumption_logs(id) ON DELETE CASCADE,
  item_id             UUID REFERENCES procurement_items(id),
  item_name           VARCHAR(255) NOT NULL,
  unit                TEXT NOT NULL,
  quantity_consumed   NUMERIC NOT NULL,
  notes               TEXT
);

CREATE INDEX idx_consumption_log_items_log ON consumption_log_items(consumption_log_id);

-- ── 7. Consumption Corrections ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumption_corrections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumption_log_item_id UUID REFERENCES consumption_log_items(id),
  consumption_log_id      UUID NOT NULL REFERENCES consumption_logs(id),
  correction_type         TEXT NOT NULL,
  original_quantity       NUMERIC NOT NULL,
  new_quantity            NUMERIC DEFAULT 0,
  reason                  TEXT NOT NULL,
  corrected_by            UUID NOT NULL REFERENCES users(id),
  new_consumption_log_id  UUID REFERENCES consumption_logs(id),
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_consumption_corrections_log ON consumption_corrections(consumption_log_id);

-- ── 8. RPC: Atomic stock update ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION upsert_location_stock(
  p_location_id UUID,
  p_item_id UUID,
  p_quantity_delta NUMERIC
) RETURNS VOID AS $$
BEGIN
  INSERT INTO location_stock (location_id, item_id, quantity_on_hand)
  VALUES (p_location_id, p_item_id, GREATEST(0, p_quantity_delta))
  ON CONFLICT (location_id, item_id)
  DO UPDATE SET
    quantity_on_hand = GREATEST(0, location_stock.quantity_on_hand + p_quantity_delta),
    last_updated = NOW();
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- ── 9. RLS ──────────────────────────────────────────────────────────────
ALTER TABLE location_stock          ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_issues   ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumption_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumption_log_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumption_corrections ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read/write all rows (role filtering in API layer)
CREATE POLICY "auth_all" ON location_stock          FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON stock_transfers         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON stock_transfer_items    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON stock_transfer_issues   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON consumption_logs        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON consumption_log_items   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON consumption_corrections FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Service role full access
GRANT ALL ON location_stock          TO service_role;
GRANT ALL ON stock_transfers         TO service_role;
GRANT ALL ON stock_transfer_items    TO service_role;
GRANT ALL ON stock_transfer_issues   TO service_role;
GRANT ALL ON consumption_logs        TO service_role;
GRANT ALL ON consumption_log_items   TO service_role;
GRANT ALL ON consumption_corrections TO service_role;

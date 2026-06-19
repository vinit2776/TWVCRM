-- ============================================================
-- Migration 00281: Procurement Consumption & Billable Transfers
-- ============================================================
-- New tables: user_locations, transfer_billing_policies
-- New columns: stock_transfers.billing_status,
--              stock_transfer_items.unit_cost_incl_gst,
--              usage_charges.charge_type, usage_charges.source_id
-- New RPC: receive_billable_transfer
-- ============================================================

-- ── 1. User-Location Assignments ────────────────────────────────────────────
CREATE TABLE user_locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  responsibility  TEXT NOT NULL DEFAULT 'primary'
                    CHECK (responsibility IN ('primary', 'secondary')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, location_id)
);

CREATE INDEX idx_user_locations_user     ON user_locations(user_id);
CREATE INDEX idx_user_locations_location ON user_locations(location_id);

ALTER TABLE user_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON user_locations FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT ALL ON user_locations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_locations TO authenticated;

-- ── 2. Transfer Billing Policies ─────────────────────────────────────────────
-- One row per location. is_billable=true means inbound transfers are billed.
-- service_charge_pct: added on top of GST-inclusive procurement cost.
-- GST rate comes from the linked contract's tax_percentage at billing time.
-- Capital Towers (Clix): service_charge_pct = 8.00
CREATE TABLE transfer_billing_policies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         UUID NOT NULL REFERENCES locations(id) UNIQUE,
  is_billable         BOOLEAN NOT NULL DEFAULT false,
  contract_id         UUID REFERENCES contracts(id),
  service_charge_pct  NUMERIC(5,2) NOT NULL DEFAULT 0
                        CHECK (service_charge_pct >= 0),
  notes               TEXT,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT billable_requires_contract
    CHECK (NOT is_billable OR contract_id IS NOT NULL)
);

CREATE INDEX idx_transfer_billing_policies_location  ON transfer_billing_policies(location_id);
CREATE INDEX idx_transfer_billing_policies_contract  ON transfer_billing_policies(contract_id);

CREATE TRIGGER update_transfer_billing_policies_updated_at
  BEFORE UPDATE ON transfer_billing_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE transfer_billing_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON transfer_billing_policies FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT ALL ON transfer_billing_policies TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON transfer_billing_policies TO authenticated;

-- ── 3. New columns on stock_transfers ────────────────────────────────────────
ALTER TABLE stock_transfers
  ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (billing_status IN ('not_applicable', 'pending', 'billed', 'error'));

CREATE INDEX idx_stock_transfers_billing_status ON stock_transfers(billing_status);

-- ── 4. New column on stock_transfer_items ────────────────────────────────────
-- GST-inclusive procurement cost per unit at the time of transfer.
ALTER TABLE stock_transfer_items
  ADD COLUMN unit_cost_incl_gst NUMERIC(12,2);

-- ── 5. New columns on usage_charges ──────────────────────────────────────────
ALTER TABLE usage_charges
  ADD COLUMN charge_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (charge_type IN ('manual', 'stock_transfer'));

ALTER TABLE usage_charges
  ADD COLUMN source_id UUID;
-- source_id for charge_type='stock_transfer' → stock_transfers.id
-- No FK because source_id polymorphically references different tables

CREATE INDEX idx_usage_charges_charge_type ON usage_charges(charge_type);
CREATE INDEX idx_usage_charges_source_id   ON usage_charges(source_id);

-- ── 6. RPC: receive_billable_transfer ─────────────────────────────────────────
-- Atomic: update quantities → create one usage_charge → auto-consume items
-- → update transfer status + billing_status.
-- Called instead of the normal receive path when destination is billable.
--
-- p_items: JSON array of {transfer_item_id, quantity_received}
CREATE OR REPLACE FUNCTION receive_billable_transfer(
  p_transfer_id   UUID,
  p_received_by   UUID,
  p_items         JSONB
) RETURNS JSONB AS $$
DECLARE
  v_transfer        RECORD;
  v_policy          RECORD;
  v_contract        RECORD;
  v_item            RECORD;
  v_input_item      JSONB;
  v_base_value      NUMERIC := 0;
  v_service_charge  NUMERIC;
  v_subtotal        NUMERIC;
  v_usage_charge_id UUID;
  v_log_id          UUID;
  v_all_match       BOOLEAN := true;
  v_new_status      TEXT;
  v_qty_received    NUMERIC;
  v_log_items       JSONB := '[]'::JSONB;
BEGIN
  -- 1. Lock and validate the transfer
  SELECT * INTO v_transfer
  FROM stock_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer not found: %', p_transfer_id;
  END IF;

  IF v_transfer.status != 'dispatched' THEN
    RAISE EXCEPTION 'Transfer % is not in dispatched status (current: %)',
      p_transfer_id, v_transfer.status;
  END IF;

  -- 2. Get billing policy for destination
  SELECT * INTO v_policy
  FROM transfer_billing_policies
  WHERE location_id = v_transfer.to_location_id
    AND is_billable = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active billing policy for destination location %',
      v_transfer.to_location_id;
  END IF;

  -- 3. Validate the linked contract is active
  SELECT id, lead_id, status INTO v_contract
  FROM contracts
  WHERE id = v_policy.contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract % not found', v_policy.contract_id;
  END IF;

  IF v_contract.status NOT IN ('active', 'renewed') THEN
    RAISE EXCEPTION 'Contract % is not active (status: %)',
      v_policy.contract_id, v_contract.status;
  END IF;

  -- 4. Update quantity_received on each item and compute aggregate base value
  FOR v_input_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_item
    FROM stock_transfer_items
    WHERE id = (v_input_item->>'transfer_item_id')::UUID
      AND transfer_id = p_transfer_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transfer item % not found in transfer %',
        v_input_item->>'transfer_item_id', p_transfer_id;
    END IF;

    v_qty_received := (v_input_item->>'quantity_received')::NUMERIC;

    UPDATE stock_transfer_items
    SET quantity_received = v_qty_received
    WHERE id = v_item.id;

    IF v_qty_received != v_item.quantity_sent THEN
      v_all_match := false;
    END IF;

    -- Accumulate base value using GST-inclusive cost
    IF v_item.unit_cost_incl_gst IS NOT NULL AND v_qty_received > 0 THEN
      v_base_value := v_base_value + (v_item.unit_cost_incl_gst * v_qty_received);
    END IF;

    -- Collect items for consumption log
    v_log_items := v_log_items || jsonb_build_object(
      'item_id', v_item.item_id,
      'item_name', v_item.item_name,
      'unit', v_item.unit,
      'quantity_consumed', v_qty_received
    );
  END LOOP;

  -- 5. Compute service charge and subtotal (pre-GST amount for usage_charge)
  v_service_charge := ROUND(v_base_value * v_policy.service_charge_pct / 100, 2);
  v_subtotal       := v_base_value + v_service_charge;

  -- 6. Create one usage_charge for the entire transfer
  INSERT INTO usage_charges (
    contract_id,
    lead_id,
    description,
    quantity,
    unit_price,
    total,
    charge_date,
    status,
    charge_type,
    source_id
  ) VALUES (
    v_policy.contract_id,
    v_contract.lead_id,
    'Stock Transfer DC #' || v_transfer.transfer_number,
    1,
    v_subtotal,
    v_subtotal,
    CURRENT_DATE,
    'pending',
    'stock_transfer',
    p_transfer_id
  )
  RETURNING id INTO v_usage_charge_id;

  -- 7. Auto-consume: create consumption_log + items (billable path skips stock addition)
  INSERT INTO consumption_logs (location_id, logged_by, notes, status)
  VALUES (
    v_transfer.to_location_id,
    p_received_by,
    'Auto-consumed via billable transfer DC #' || v_transfer.transfer_number,
    'active'
  )
  RETURNING id INTO v_log_id;

  INSERT INTO consumption_log_items (
    consumption_log_id,
    item_id,
    item_name,
    unit,
    quantity_consumed
  )
  SELECT
    v_log_id,
    (item->>'item_id')::UUID,
    item->>'item_name',
    item->>'unit',
    (item->>'quantity_consumed')::NUMERIC
  FROM jsonb_array_elements(v_log_items) AS item;

  -- 8. Update transfer status and billing_status
  v_new_status := CASE WHEN v_all_match THEN 'completed' ELSE 'received' END;

  UPDATE stock_transfers
  SET
    status         = v_new_status,
    billing_status = 'billed',
    received_by    = p_received_by,
    received_at    = NOW()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'status', v_new_status,
    'billing_status', 'billed',
    'usage_charge_id', v_usage_charge_id,
    'consumption_log_id', v_log_id,
    'base_value', v_base_value,
    'service_charge', v_service_charge,
    'subtotal', v_subtotal
  );
END;
$$ LANGUAGE plpgsql SET search_path = public;

GRANT EXECUTE ON FUNCTION receive_billable_transfer(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION receive_billable_transfer(UUID, UUID, JSONB) TO service_role;

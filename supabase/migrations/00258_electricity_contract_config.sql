-- Electricity Sub-Billing: contract-level config + bill_side split
--
-- All changes are additive (safe zero-downtime migration).
-- Existing electricity_bills rows remain valid (bill_side defaults to 'customer').
--
-- Rollback:
--   DROP FUNCTION IF EXISTS approve_electricity_landlord_bill(UUID);
--   DROP INDEX IF EXISTS idx_eb_landlord_unique;
--   DROP INDEX IF EXISTS idx_eb_customer_unique;
--   DROP INDEX IF EXISTS idx_eb_bills_location_month_unique; -- recreate old one manually
--   ALTER TABLE electricity_bills DROP COLUMN IF EXISTS landlord_bill_id;
--   ALTER TABLE electricity_bills DROP COLUMN IF EXISTS bill_side;
--   DROP TABLE IF EXISTS contract_electricity_config;
--   ALTER TABLE location_electricity_config DROP COLUMN IF EXISTS landlord_utility_rate;
--   ALTER TABLE location_electricity_config DROP COLUMN IF EXISTS service_number;

-- ============================================================
-- 1. location_electricity_config — add service_number + landlord_utility_rate
-- ============================================================

ALTER TABLE location_electricity_config
  ADD COLUMN IF NOT EXISTS service_number TEXT,
  ADD COLUMN IF NOT EXISTS landlord_utility_rate NUMERIC(10,2) NOT NULL DEFAULT 0
    CHECK (landlord_utility_rate >= 0);

-- ============================================================
-- 2. contract_electricity_config
-- Per-contract settings: which location, what ratio, what customer rates.
-- Replaces the JSONB contracts.electricity_settings field.
-- ============================================================

CREATE TABLE IF NOT EXISTS contract_electricity_config (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id               UUID NOT NULL UNIQUE REFERENCES contracts(id) ON DELETE CASCADE,
  location_id               UUID NOT NULL REFERENCES locations(id),

  -- Master switch: contract is opted in to electricity billing at this location
  enabled                   BOOLEAN NOT NULL DEFAULT false,

  -- Customer allocation ratios (% of landlord units this contract is billed for)
  -- These are independent of the landlord split. Sum does not need to be 100 across contracts.
  utility_ratio             NUMERIC(5,2) NOT NULL DEFAULT 0
                              CHECK (utility_ratio >= 0 AND utility_ratio <= 100),
  generator_ratio           NUMERIC(5,2) NOT NULL DEFAULT 0
                              CHECK (generator_ratio >= 0 AND generator_ratio <= 100),

  -- Customer-facing rates (independent / marked-up from landlord tariff)
  customer_utility_rate     NUMERIC(10,2) NOT NULL DEFAULT 0
                              CHECK (customer_utility_rate >= 0),
  customer_generator_rate   NUMERIC(10,2) NOT NULL DEFAULT 0
                              CHECK (customer_generator_rate >= 0),

  -- GST on customer invoice — defaults to contract.tax_percentage, overridable
  customer_gst_rate         NUMERIC(5,2) NOT NULL DEFAULT 18
                              CHECK (customer_gst_rate >= 0),

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cec_contract  ON contract_electricity_config(contract_id);
CREATE INDEX idx_cec_location  ON contract_electricity_config(location_id);

CREATE TRIGGER update_contract_electricity_config_updated_at
  BEFORE UPDATE ON contract_electricity_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE contract_electricity_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read contract_electricity_config"
  ON contract_electricity_config FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert contract_electricity_config"
  ON contract_electricity_config FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update contract_electricity_config"
  ON contract_electricity_config FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ============================================================
-- 3. electricity_bills — add bill_side + landlord_bill_id
-- bill_side = 'landlord': one row per location+month (the landlord bill)
-- bill_side = 'customer': one row per contract+month (generated on approve)
-- ============================================================

ALTER TABLE electricity_bills
  ADD COLUMN IF NOT EXISTS bill_side TEXT NOT NULL DEFAULT 'customer'
    CHECK (bill_side IN ('landlord', 'customer')),
  ADD COLUMN IF NOT EXISTS landlord_bill_id UUID
    REFERENCES electricity_bills(id);

CREATE INDEX IF NOT EXISTS idx_eb_landlord_bill_id ON electricity_bills(landlord_bill_id);

-- Drop old unique index (was per location+month only; now we need bill_side separation)
DROP INDEX IF EXISTS idx_eb_bills_location_month_unique;

-- One active landlord bill per location+month
CREATE UNIQUE INDEX idx_eb_landlord_unique
  ON electricity_bills(location_id, bill_month, bill_year)
  WHERE bill_side = 'landlord' AND status != 'revised';

-- One active customer bill per contract+month
CREATE UNIQUE INDEX idx_eb_customer_unique
  ON electricity_bills(contract_id, bill_month, bill_year)
  WHERE bill_side = 'customer' AND status != 'revised';

-- ============================================================
-- 4. RPC: approve_electricity_landlord_bill
-- Atomically generates one customer electricity_bills row per enabled contract
-- mapped to this location. Must run inside a single transaction.
-- Called by POST /api/electricity-bills/[id]/approve
-- ============================================================

CREATE OR REPLACE FUNCTION approve_electricity_landlord_bill(p_landlord_bill_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bill          electricity_bills%ROWTYPE;
  v_config        location_electricity_config%ROWTYPE;
  v_contract_cfg  contract_electricity_config%ROWTYPE;
  v_generated     UUID[] := '{}';
  v_customer_id   UUID;
  v_utility_units NUMERIC;
  v_gen_units     NUMERIC;
  v_subtotal      NUMERIC;
  v_gst           NUMERIC;
  v_total         NUMERIC;
BEGIN
  -- Lock the landlord bill row
  SELECT * INTO v_bill
  FROM electricity_bills
  WHERE id = p_landlord_bill_id AND bill_side = 'landlord'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Landlord bill not found: %', p_landlord_bill_id;
  END IF;

  IF v_bill.status != 'draft' THEN
    RAISE EXCEPTION 'Bill is not in draft status (current: %)', v_bill.status;
  END IF;

  -- Fetch location config for landlord unit totals
  SELECT * INTO v_config
  FROM location_electricity_config
  WHERE location_id = v_bill.location_id;

  -- Iterate over all enabled contracts mapped to this location
  FOR v_contract_cfg IN
    SELECT cec.*
    FROM contract_electricity_config cec
    JOIN contracts c ON c.id = cec.contract_id
    WHERE cec.location_id = v_bill.location_id
      AND cec.enabled = true
      AND c.status IN ('active', 'renewal')
  LOOP
    -- Compute units: ratio% of total landlord units captured in bill lines
    SELECT
      COALESCE(SUM(CASE WHEN line_type = 'utility'   THEN units ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN line_type = 'generator' THEN units ELSE 0 END), 0)
    INTO v_utility_units, v_gen_units
    FROM electricity_bill_lines
    WHERE electricity_bill_id = p_landlord_bill_id;

    v_utility_units := ROUND(v_utility_units * v_contract_cfg.utility_ratio   / 100, 2);
    v_gen_units     := ROUND(v_gen_units     * v_contract_cfg.generator_ratio / 100, 2);

    v_subtotal := ROUND(
      v_utility_units * v_contract_cfg.customer_utility_rate +
      v_gen_units     * v_contract_cfg.customer_generator_rate,
      2
    );
    v_gst := ROUND(v_subtotal * v_contract_cfg.customer_gst_rate / 100, 2);
    v_total := v_subtotal + v_gst;

    -- Insert customer bill (idempotent via unique index; skip if already exists)
    INSERT INTO electricity_bills (
      location_id,
      contract_id,
      bill_side,
      landlord_bill_id,
      bill_month,
      bill_year,
      landlord_bill_number,
      landlord_bill_date,
      landlord_total_amount,
      reimbursement_enabled,
      landlord_utility_pct,
      landlord_generator_pct,
      customer_utility_pct,
      customer_generator_pct,
      customer_units_billed,
      customer_markup_type,
      customer_markup_value,
      customer_utility_rate,
      customer_generator_rate,
      customer_subtotal,
      customer_cgst,
      customer_sgst,
      customer_total,
      customer_round_off,
      gst_rate,
      status,
      created_by
    )
    VALUES (
      v_bill.location_id,
      v_contract_cfg.contract_id,
      'customer',
      p_landlord_bill_id,
      v_bill.bill_month,
      v_bill.bill_year,
      v_bill.landlord_bill_number,
      v_bill.landlord_bill_date,
      v_bill.landlord_total_amount,
      true,
      COALESCE(v_config.landlord_utility_pct, 90),
      COALESCE(v_config.landlord_generator_pct, 10),
      v_contract_cfg.utility_ratio,
      v_contract_cfg.generator_ratio,
      v_utility_units + v_gen_units,
      'per_unit',
      0,
      v_contract_cfg.customer_utility_rate,
      v_contract_cfg.customer_generator_rate,
      v_subtotal,
      ROUND(v_gst / 2, 2),
      ROUND(v_gst / 2, 2),
      v_total,
      0,
      v_contract_cfg.customer_gst_rate,
      'draft',
      v_bill.created_by
    )
    ON CONFLICT (contract_id, bill_month, bill_year)
    WHERE bill_side = 'customer' AND status != 'revised'
    DO NOTHING
    RETURNING id INTO v_customer_id;

    IF v_customer_id IS NOT NULL THEN
      v_generated := v_generated || v_customer_id;
    END IF;
  END LOOP;

  -- Mark landlord bill as invoiced
  UPDATE electricity_bills
  SET status = 'invoiced', confirmed_at = NOW()
  WHERE id = p_landlord_bill_id;

  RETURN jsonb_build_object(
    'landlord_bill_id', p_landlord_bill_id,
    'customer_bills_generated', array_length(v_generated, 1),
    'customer_bill_ids', v_generated
  );
END;
$$;

-- Link an already-uploaded vendor bill to electricity details (Phase 2, PR B2)
--
-- Bills are uploaded as vendor bills (Procurement → Bills). This lets one be tied to a
-- location/connection and given its billing period, units, meter readings and charge
-- breakdown, so it can be reconciled against OneGrid — without creating a second payable.
--
-- A linked record is an electricity_bills row (bill_side 'landlord', status 'draft', so the
-- existing screens and the customer re-billing step still understand it). It points at the
-- vendor bill through its OWN column, source_vendor_bill_id, and deliberately leaves
-- vendor_bill_id empty. Every existing step that acts on a vendor bill finds it through
-- vendor_bill_id — approve (auto-approves the payable), edit (rewrites its amounts) and
-- delete (deletes it) — so a linked record can never approve, rewrite or delete a payable
-- someone uploaded. Unlinking (the existing admin delete) removes only the details.
--
-- Additive: new nullable columns, a unique index, one new function. Nothing is backfilled;
-- no existing row or function is changed.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS link_vendor_bill_to_electricity(UUID, UUID, UUID, UUID, INTEGER, INTEGER, DATE, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, JSONB);
--   DROP INDEX IF EXISTS uq_eb_source_vendor_bill;
--   ALTER TABLE electricity_bills DROP CONSTRAINT IF EXISTS electricity_bills_period_check, DROP CONSTRAINT IF EXISTS electricity_bills_pf_check,
--     DROP COLUMN IF EXISTS printed_name, DROP COLUMN IF EXISTS consumer_number_on_bill, DROP COLUMN IF EXISTS billed_pf,
--     DROP COLUMN IF EXISTS max_demand_kva, DROP COLUMN IF EXISTS closing_reading, DROP COLUMN IF EXISTS opening_reading,
--     DROP COLUMN IF EXISTS units_billed, DROP COLUMN IF EXISTS period_end, DROP COLUMN IF EXISTS period_start,
--     DROP COLUMN IF EXISTS connection_id, DROP COLUMN IF EXISTS source_vendor_bill_id;
--   ALTER TABLE electricity_bill_lines DROP COLUMN IF EXISTS charge_category;

ALTER TABLE electricity_bills
  ADD COLUMN IF NOT EXISTS source_vendor_bill_id   UUID REFERENCES vendor_bills(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS connection_id           UUID REFERENCES location_electricity_connections(id),
  ADD COLUMN IF NOT EXISTS period_start            DATE,
  ADD COLUMN IF NOT EXISTS period_end              DATE,
  -- Grid (utility) kWh billed — what the OneGrid main meter can be compared with. Generator units are separate.
  ADD COLUMN IF NOT EXISTS units_billed            NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS opening_reading         NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS closing_reading         NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS max_demand_kva          NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS billed_pf               NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS consumer_number_on_bill TEXT,
  ADD COLUMN IF NOT EXISTS printed_name            TEXT;

ALTER TABLE electricity_bills
  ADD CONSTRAINT electricity_bills_period_check
    CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  ADD CONSTRAINT electricity_bills_pf_check
    CHECK (billed_pf IS NULL OR (billed_pf > 0 AND billed_pf <= 1));

-- A vendor bill carries at most one active set of electricity details.
CREATE UNIQUE INDEX IF NOT EXISTS uq_eb_source_vendor_bill
  ON electricity_bills(source_vendor_bill_id)
  WHERE source_vendor_bill_id IS NOT NULL AND status != 'revised';

CREATE INDEX IF NOT EXISTS idx_eb_connection_period
  ON electricity_bills(connection_id, period_start) WHERE connection_id IS NOT NULL;

ALTER TABLE electricity_bill_lines
  ADD COLUMN IF NOT EXISTS charge_category TEXT
    CHECK (charge_category IS NULL OR charge_category IN
      ('energy', 'generator', 'fixed_demand', 'pf_adjustment', 'taxes', 'arrears', 'other'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Atomic link. Locks the vendor bill, re-checks every invariant under the lock, and
-- writes the electricity record + lines together, so two people linking the same bill, or
-- a bill changing underneath, cannot leave a half-made record. Error messages start with a
-- stable LINK_* code the API maps to an HTTP status.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION link_vendor_bill_to_electricity(
  p_vendor_bill_id  UUID,
  p_user_id         UUID,
  p_location_id     UUID,
  p_connection_id   UUID,
  p_bill_month      INTEGER,
  p_bill_year       INTEGER,
  p_period_start    DATE,
  p_period_end      DATE,
  p_units_billed    NUMERIC,
  p_opening         NUMERIC,
  p_closing         NUMERIC,
  p_max_demand      NUMERIC,
  p_billed_pf       NUMERIC,
  p_consumer_number TEXT,
  p_printed_name    TEXT,
  p_lines           JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vb       vendor_bills%ROWTYPE;
  v_vendor   procurement_vendors%ROWTYPE;
  v_loc      locations%ROWTYPE;
  v_conn     location_electricity_connections%ROWTYPE;
  v_cfg      location_electricity_config%ROWTYPE;
  v_new      UUID;
  v_elem     JSONB;
  v_cat      TEXT;
  v_type     TEXT;
  v_units    NUMERIC;
  v_rate     NUMERIC;
  v_amount   NUMERIC;
  v_sum      NUMERIC := 0;
  v_idx      INTEGER := 0;
  v_first    DATE;
  v_last     DATE;
  v_constraint TEXT;
BEGIN
  SELECT * INTO v_vb FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINK_BILL_NOT_FOUND: vendor bill not found'; END IF;
  IF v_vb.approval_status = 'rejected' THEN RAISE EXCEPTION 'LINK_BILL_REJECTED: a rejected bill cannot be linked'; END IF;
  IF v_vb.po_id IS NOT NULL THEN RAISE EXCEPTION 'LINK_BILL_HAS_PO: a bill linked to a purchase order takes its details from the PO'; END IF;
  IF v_vb.electricity_bill_id IS NOT NULL THEN
    RAISE EXCEPTION 'LINK_ALREADY_CAPTURED: this bill was created through electricity capture and already has its details';
  END IF;
  IF EXISTS (SELECT 1 FROM electricity_bills WHERE source_vendor_bill_id = p_vendor_bill_id AND status <> 'revised') THEN
    RAISE EXCEPTION 'LINK_ALREADY_LINKED: this bill already has electricity details';
  END IF;

  SELECT * INTO v_vendor FROM procurement_vendors WHERE id = v_vb.vendor_id;
  IF NOT FOUND OR NOT v_vendor.is_electricity_provider THEN
    RAISE EXCEPTION 'LINK_NOT_ELECTRICITY_VENDOR: this vendor is not marked as an electricity provider';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINK_LOCATION_NOT_FOUND: location not found'; END IF;
  IF v_loc.company_id IS NOT NULL AND v_vb.company_id IS NOT NULL AND v_loc.company_id <> v_vb.company_id THEN
    RAISE EXCEPTION 'LINK_COMPANY_MISMATCH: % belongs to a different company from this bill', v_loc.name;
  END IF;

  IF p_connection_id IS NOT NULL THEN
    SELECT * INTO v_conn FROM location_electricity_connections WHERE id = p_connection_id;
    IF NOT FOUND OR NOT v_conn.is_active OR v_conn.vendor_id <> v_vb.vendor_id OR v_conn.location_id <> p_location_id THEN
      RAISE EXCEPTION 'LINK_CONNECTION_INVALID: that connection does not belong to this vendor and location';
    END IF;
  END IF;

  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION 'LINK_PERIOD_INVALID: the billing period is missing or ends before it starts';
  END IF;
  IF p_period_end - p_period_start > 93 THEN
    RAISE EXCEPTION 'LINK_PERIOD_TOO_LONG: a billing period longer than about three months looks wrong';
  END IF;

  -- The month the bill counts as must overlap its period (the API picks the month holding most of its days).
  v_first := make_date(p_bill_year, p_bill_month, 1);
  v_last  := (v_first + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
  IF v_last < p_period_start OR v_first > p_period_end THEN
    RAISE EXCEPTION 'LINK_MONTH_OUTSIDE_PERIOD: the bill month does not overlap the billing period';
  END IF;

  -- No other active record on the same connection (or, when none is set, at the same location) may cover these dates.
  IF EXISTS (
    SELECT 1 FROM electricity_bills eb
    WHERE eb.bill_side = 'landlord' AND eb.status <> 'revised'
      AND eb.location_id = p_location_id
      AND eb.period_start IS NOT NULL
      AND (p_connection_id IS NULL OR eb.connection_id IS NULL OR eb.connection_id = p_connection_id)
      AND eb.period_start <= p_period_end AND eb.period_end >= p_period_start
  ) THEN
    RAISE EXCEPTION 'LINK_PERIOD_OVERLAP: another electricity bill already covers part of these dates at this location';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'LINK_LINES_REQUIRED: at least one charge line is required';
  END IF;

  -- Validate lines and total them; energy/generator lines are units x rate, the rest carry an amount.
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_cat := v_elem->>'charge_category';
    IF v_cat IS NULL OR v_cat NOT IN ('energy','generator','fixed_demand','pf_adjustment','taxes','arrears','other') THEN
      RAISE EXCEPTION 'LINK_LINE_INVALID: unknown charge type on line %', v_idx + 1;
    END IF;
    IF v_cat IN ('energy','generator') THEN
      v_units := NULLIF(v_elem->>'units','')::NUMERIC;
      v_rate  := NULLIF(v_elem->>'rate','')::NUMERIC;
      IF v_units IS NULL OR v_units <= 0 OR v_rate IS NULL OR v_rate <= 0 THEN
        RAISE EXCEPTION 'LINK_LINE_INVALID: line % needs units and a rate above zero', v_idx + 1;
      END IF;
      v_amount := ROUND(v_units * v_rate, 2);
    ELSE
      v_amount := NULLIF(v_elem->>'amount','')::NUMERIC;
      IF v_amount IS NULL OR v_amount = 0 THEN
        RAISE EXCEPTION 'LINK_LINE_INVALID: line % needs an amount', v_idx + 1;
      END IF;
    END IF;
    v_sum := v_sum + v_amount;
    v_idx := v_idx + 1;
  END LOOP;

  -- The vendor bill is what gets paid, so the details must agree with it.
  IF ABS(v_sum - v_vb.total_amount) > 1.00 THEN
    RAISE EXCEPTION 'LINK_TOTAL_MISMATCH: the lines add up to % but the vendor bill is %', v_sum, v_vb.total_amount;
  END IF;

  SELECT * INTO v_cfg FROM location_electricity_config WHERE location_id = p_location_id;

  INSERT INTO electricity_bills (
    location_id, contract_id, bill_side, bill_month, bill_year,
    landlord_bill_number, landlord_bill_date, landlord_total_amount, attachment_path,
    landlord_gst_applicable, landlord_gst_amount,
    reimbursement_enabled, landlord_utility_pct, landlord_generator_pct,
    status, created_by,
    source_vendor_bill_id, connection_id, period_start, period_end,
    units_billed, opening_reading, closing_reading, max_demand_kva, billed_pf,
    consumer_number_on_bill, printed_name
  ) VALUES (
    p_location_id, NULL, 'landlord', p_bill_month, p_bill_year,
    v_vb.invoice_number, v_vb.invoice_date, v_vb.total_amount, v_vb.invoice_file_url,
    false, 0,
    COALESCE(v_cfg.reimbursement_enabled, false), COALESCE(v_cfg.landlord_utility_pct, 100), COALESCE(v_cfg.landlord_generator_pct, 0),
    'draft', p_user_id,
    p_vendor_bill_id, p_connection_id, p_period_start, p_period_end,
    p_units_billed, p_opening, p_closing, p_max_demand, p_billed_pf,
    NULLIF(btrim(p_consumer_number), ''), NULLIF(btrim(p_printed_name), '')
  )
  RETURNING id INTO v_new;

  v_idx := 0;
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_cat := v_elem->>'charge_category';
    v_type := CASE v_cat WHEN 'energy' THEN 'utility' WHEN 'generator' THEN 'generator' ELSE 'other' END;
    IF v_cat IN ('energy','generator') THEN
      v_units  := (v_elem->>'units')::NUMERIC;
      v_rate   := (v_elem->>'rate')::NUMERIC;
      v_amount := ROUND(v_units * v_rate, 2);
    ELSE
      v_units := NULL; v_rate := NULL; v_amount := (v_elem->>'amount')::NUMERIC;
    END IF;
    INSERT INTO electricity_bill_lines (electricity_bill_id, line_type, charge_category, meter_label, label, units, rate, amount, sort_order)
    VALUES (v_new, v_type, v_cat, NULLIF(btrim(v_elem->>'meter_label'), ''), NULLIF(btrim(v_elem->>'label'), ''), v_units, v_rate, v_amount, v_idx);
    v_idx := v_idx + 1;
  END LOOP;

  -- Record where the vendor bill is for. A bill uploaded before the form asked for a location has none yet.
  UPDATE vendor_bills
  SET location_id = p_location_id,
      connection_id = p_connection_id,
      electricity_consumer_number = COALESCE(NULLIF(btrim(p_consumer_number), ''), electricity_consumer_number),
      electricity_printed_name    = COALESCE(NULLIF(btrim(p_printed_name), ''), electricity_printed_name)
  WHERE id = p_vendor_bill_id;

  RETURN jsonb_build_object('electricity_bill_id', v_new, 'bill_month', p_bill_month, 'bill_year', p_bill_year, 'lines_total', v_sum);

EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'uq_eb_source_vendor_bill' THEN
      -- Two people linked the same bill at once; the other one won.
      RAISE EXCEPTION 'LINK_ALREADY_LINKED: this bill already has electricity details';
    END IF;
    -- Otherwise the existing rule: one landlord record per location per month.
    RAISE EXCEPTION 'LINK_MONTH_TAKEN: an electricity bill record already exists for this location and month';
END;
$$;

-- The function does its own validation but no caller check, so only the server (service role) may run it.
REVOKE ALL ON FUNCTION link_vendor_bill_to_electricity(UUID, UUID, UUID, UUID, INTEGER, INTEGER, DATE, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION link_vendor_bill_to_electricity(UUID, UUID, UUID, UUID, INTEGER, INTEGER, DATE, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) TO service_role;

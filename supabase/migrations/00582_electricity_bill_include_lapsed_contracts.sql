-- Approving a landlord electricity bill only generated customer bills for
-- contracts whose status was active/renewal_in_progress AT APPROVAL TIME, with
-- no regard to the bill's month. A contract that expired (or was terminated)
-- after serving the bill's month — e.g. Godrej A2 expiring in October while the
-- September bill is still in draft — was silently skipped, so its reimbursement
-- was never invoiced. Now a contract that was activated and whose term overlaps
-- the bill's month is included regardless of its current status. Full share, no
-- proration (unchanged). Mirrored by the approval-preview API route.
--
-- Rollback: re-apply the function body from 00340_electricity_auto_approve_vendor_bill.sql.

CREATE OR REPLACE FUNCTION approve_electricity_landlord_bill(p_landlord_bill_id UUID, p_approved_by UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bill              electricity_bills%ROWTYPE;
  v_config            location_electricity_config%ROWTYPE;
  v_contract_cfg      contract_electricity_config%ROWTYPE;
  v_profile           electricity_billing_profiles%ROWTYPE;
  v_generated         UUID[] := '{}';
  v_customer_id       UUID;
  v_utility_units     NUMERIC;   -- landlord's captured utility-only units
  v_gen_units         NUMERIC;   -- landlord's captured generator-only units
  v_total_units       NUMERIC;   -- combined total (the base the customer ratio applies to)
  v_eff_utility_rate  NUMERIC;   -- landlord's weighted-avg utility rate for this bill
  v_eff_gen_rate      NUMERIC;   -- landlord's weighted-avg generator rate for this bill
  v_cust_utility_pct  NUMERIC;
  v_cust_gen_pct      NUMERIC;
  v_cust_utility_units NUMERIC;
  v_cust_gen_units    NUMERIC;
  v_cust_utility_rate NUMERIC;
  v_cust_gen_rate     NUMERIC;
  v_cust_gst_rate     NUMERIC;
  v_subtotal          NUMERIC;
  v_gst               NUMERIC;
  v_total             NUMERIC;
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

  -- Landlord's captured units + effective (weighted-avg) rate per line type,
  -- computed once for this bill (shared across all contracts at this location).
  SELECT
    COALESCE(SUM(CASE WHEN line_type = 'utility'   THEN units ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type = 'generator' THEN units ELSE 0 END), 0),
    CASE WHEN SUM(CASE WHEN line_type = 'utility' THEN units ELSE 0 END) > 0
      THEN SUM(CASE WHEN line_type = 'utility' THEN amount ELSE 0 END)
           / SUM(CASE WHEN line_type = 'utility' THEN units ELSE 0 END)
      ELSE 0 END,
    CASE WHEN SUM(CASE WHEN line_type = 'generator' THEN units ELSE 0 END) > 0
      THEN SUM(CASE WHEN line_type = 'generator' THEN amount ELSE 0 END)
           / SUM(CASE WHEN line_type = 'generator' THEN units ELSE 0 END)
      ELSE 0 END
  INTO v_utility_units, v_gen_units, v_eff_utility_rate, v_eff_gen_rate
  FROM electricity_bill_lines
  WHERE electricity_bill_id = p_landlord_bill_id;

  v_total_units := v_utility_units + v_gen_units;

  -- Iterate over all enabled contracts mapped to this location
  FOR v_contract_cfg IN
    SELECT cec.*
    FROM contract_electricity_config cec
    JOIN contracts c ON c.id = cec.contract_id
    WHERE cec.location_id = v_bill.location_id
      AND cec.enabled = true
      AND (
        c.status IN ('active', 'renewal_in_progress')
        OR (
          -- Expired/terminated AFTER serving this bill's month still owes its
          -- share. activated_at excludes never-activated withdrawn contracts
          -- (stored as 'terminated'). A terminated contract's effective end is
          -- the earlier of its end_date and the day it was terminated.
          c.status IN ('expired', 'terminated')
          AND c.activated_at IS NOT NULL
          AND c.start_date <= (make_date(v_bill.bill_year, v_bill.bill_month, 1) + INTERVAL '1 month - 1 day')::date
          AND LEAST(c.end_date, COALESCE(c.terminated_at::date, c.end_date))
              >= make_date(v_bill.bill_year, v_bill.bill_month, 1)
        )
      )
  LOOP
    IF v_contract_cfg.billing_profile_id IS NOT NULL THEN
      SELECT * INTO v_profile
      FROM electricity_billing_profiles
      WHERE id = v_contract_cfg.billing_profile_id;

      v_cust_utility_pct := v_profile.customer_utility_pct;
      v_cust_gen_pct     := v_profile.customer_generator_pct;
      v_cust_gst_rate    := v_profile.customer_gst_rate;

      v_cust_utility_rate := CASE v_profile.utility_markup_type
        WHEN 'per_unit' THEN v_eff_utility_rate + v_profile.utility_markup_value
        ELSE v_eff_utility_rate * (1 + v_profile.utility_markup_value / 100)
      END;
      v_cust_gen_rate := CASE v_profile.generator_markup_type
        WHEN 'per_unit' THEN v_eff_gen_rate + v_profile.generator_markup_value
        ELSE v_eff_gen_rate * (1 + v_profile.generator_markup_value / 100)
      END;
    ELSE
      -- Legacy fallback: no profile assigned, use the contract's raw
      -- ratio/absolute-rate columns exactly as before (pre-00322 behavior).
      v_cust_utility_pct  := v_contract_cfg.utility_ratio;
      v_cust_gen_pct      := v_contract_cfg.generator_ratio;
      v_cust_gst_rate     := v_contract_cfg.customer_gst_rate;
      v_cust_utility_rate := v_contract_cfg.customer_utility_rate;
      v_cust_gen_rate     := v_contract_cfg.customer_generator_rate;
    END IF;

    -- Ratio applies to the COMBINED total landlord units (the 00322 bug fix).
    v_cust_utility_units := ROUND(v_total_units * v_cust_utility_pct / 100, 2);
    v_cust_gen_units      := ROUND(v_total_units * v_cust_gen_pct     / 100, 2);

    v_subtotal := ROUND(
      v_cust_utility_units * v_cust_utility_rate +
      v_cust_gen_units     * v_cust_gen_rate,
      2
    );
    v_gst := ROUND(v_subtotal * v_cust_gst_rate / 100, 2);
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
      billing_profile_id,
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
      v_cust_utility_pct,
      v_cust_gen_pct,
      v_cust_utility_units + v_cust_gen_units,
      -- customer_markup_type/value is a single legacy pair that can't represent
      -- two independent per-type formulas; only meaningful on the legacy
      -- (no-profile) path. When a profile is used, billing_profile_id is the
      -- authoritative record of the formula and this pair is left NULL.
      CASE WHEN v_contract_cfg.billing_profile_id IS NULL THEN 'per_unit' ELSE NULL END,
      CASE WHEN v_contract_cfg.billing_profile_id IS NULL THEN v_contract_cfg.customer_utility_rate - v_eff_utility_rate ELSE NULL END,
      v_cust_utility_rate,
      v_cust_gen_rate,
      v_subtotal,
      ROUND(v_gst / 2, 2),
      ROUND(v_gst / 2, 2),
      v_total,
      0,
      v_cust_gst_rate,
      v_contract_cfg.billing_profile_id,
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

  -- No contract mapped at this location (zero customer bills generated) —
  -- route straight to Accounts Payable: the electricity-bill approval just
  -- performed is sufficient authorization, so auto-approve the linked
  -- vendor bill instead of requiring a second, separate Procurement approval.
  IF array_length(v_generated, 1) IS NULL AND v_bill.vendor_bill_id IS NOT NULL THEN
    UPDATE vendor_bills
    SET approval_status = 'approved',
        approved_by = p_approved_by,
        approved_at = NOW()
    WHERE id = v_bill.vendor_bill_id
      AND approval_status = 'pending';
  END IF;

  RETURN jsonb_build_object(
    'landlord_bill_id', p_landlord_bill_id,
    'customer_bills_generated', array_length(v_generated, 1),
    'customer_bill_ids', v_generated
  );
END;
$$;

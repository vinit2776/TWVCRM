-- Atomic helper for recalculating facility usage charges after a quota change.
--
-- Previously this was done in two separate JS round-trips:
--   1. SELECT unlinked charges → UPDATE to link them     (C3: TOCTOU race window)
--   2. Loop over linked charges → UPDATE each one-by-one (C2: non-transactional)
--
-- Moving both steps into a single PL/pgSQL function fixes both issues:
--   • The whole function runs inside one transaction — a crash rolls everything back.
--   • FOR UPDATE on the cursor locks rows before scoring, so a concurrent
--     quota change cannot modify the same charges simultaneously.

CREATE OR REPLACE FUNCTION recalc_facility_charges(
  p_contract_id       UUID,
  p_facility_id       UUID,
  p_new_free_quota    NUMERIC,
  p_new_cost_per_unit NUMERIC,
  p_retroactive       BOOLEAN,
  p_month_start       DATE,
  p_month_end         DATE
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_consumed       NUMERIC := 0;
  v_charge         RECORD;
  v_overage_qty    NUMERIC;
  v_new_total      NUMERIC;
  v_gst_amount     NUMERIC;
  v_total_with_gst NUMERIC;
BEGIN
  -- ── Step 1: claim unlinked charges (retroactive = new facility being added) ─
  -- Single UPDATE eliminates the SELECT-then-UPDATE race: whoever runs this
  -- first wins the rows; the second concurrent call finds nothing left to claim.
  IF p_retroactive THEN
    UPDATE usage_charges
    SET    contract_facility_id = p_facility_id
    WHERE  contract_id          = p_contract_id
      AND  contract_facility_id IS NULL
      AND  billing_statement_id IS NULL
      AND  status IN ('pending', 'waived')
      AND  charge_date BETWEEN p_month_start AND p_month_end;
  END IF;

  -- ── Step 2: lock and rescore linked charges chronologically ─────────────────
  -- FOR UPDATE acquires row-level locks before the loop begins, so a concurrent
  -- PATCH (quota change) on the same contract will block until this completes.
  -- Secondary sort by created_at makes same-date ordering deterministic.
  FOR v_charge IN
    SELECT id, quantity, COALESCE(gst_rate, 0) AS gst_rate
    FROM   usage_charges
    WHERE  contract_id          = p_contract_id
      AND  contract_facility_id = p_facility_id
      AND  billing_statement_id IS NULL
      AND  status IN ('pending', 'waived')
      AND  charge_date BETWEEN p_month_start AND p_month_end
    ORDER BY charge_date ASC, created_at ASC
    FOR UPDATE
  LOOP
    v_overage_qty    := GREATEST(0, v_charge.quantity - GREATEST(0, p_new_free_quota - v_consumed));
    v_consumed       := v_consumed + v_charge.quantity;

    v_new_total      := ROUND(v_overage_qty * p_new_cost_per_unit, 2);
    v_gst_amount     := ROUND(v_new_total * v_charge.gst_rate / 100, 2);
    v_total_with_gst := v_new_total + v_gst_amount;

    UPDATE usage_charges
    SET
      status         = CASE WHEN v_overage_qty > 0 THEN 'pending' ELSE 'waived' END,
      quantity       = CASE WHEN v_overage_qty > 0 THEN v_overage_qty ELSE v_charge.quantity END,
      unit_price     = CASE WHEN v_overage_qty > 0 THEN p_new_cost_per_unit ELSE 0 END,
      total          = v_new_total,
      gst_amount     = v_gst_amount,
      total_with_gst = v_total_with_gst
    WHERE id = v_charge.id;
  END LOOP;
END;
$$;

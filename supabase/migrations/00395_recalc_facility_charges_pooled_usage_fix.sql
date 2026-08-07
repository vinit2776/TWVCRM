-- Fix recalc_facility_charges for the pooled-usage billing redesign (Model
-- B). Two changes:
--
-- 1. Order by true checkout chronology (created_at) only, not
--    charge_date-then-created_at. Under Model B a charge is created
--    exactly at checkout, so created_at IS checkout order — whoever
--    settled first gets the free hours first, regardless of which day
--    they'd booked for. Under the old charge_date-first ordering, a
--    booking checked out very late relative to others that month could
--    sort out of true chronological order.
--
-- 2. Stop overwriting `quantity` on the pending branch. Previously, a
--    charged row's quantity was rewritten to just its overage portion
--    (v_overage_qty), discarding the booking's true actual/booked hours.
--    That was harmless the first time this ran (the old model's insert
--    already stored quantity=overage-only for a charged row), but corrupts
--    a SECOND recalc — and, critically, corrupts Model B's pooling math
--    going forward: every checkout sums prior charges' `quantity` to know
--    how many hours are already consumed this month
--    (maybePostPooledUsageCharge, src/app/api/bookings/[id]/route.ts), and
--    that sum must always be the FULL actual hours per booking, never
--    just the overage slice. quantity is now immutable once inserted —
--    only the money fields (status/unit_price/total/gst_amount/
--    total_with_gst) are rescored on a quota/rate edit.
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
  IF p_retroactive THEN
    UPDATE usage_charges
    SET    contract_facility_id = p_facility_id
    WHERE  contract_id          = p_contract_id
      AND  contract_facility_id IS NULL
      AND  billing_statement_id IS NULL
      AND  status IN ('pending', 'waived')
      AND  charge_date BETWEEN p_month_start AND p_month_end;
  END IF;

  -- ── Step 2: lock and rescore linked charges in true checkout order ──────────
  FOR v_charge IN
    SELECT id, quantity, COALESCE(gst_rate, 0) AS gst_rate
    FROM   usage_charges
    WHERE  contract_id          = p_contract_id
      AND  contract_facility_id = p_facility_id
      AND  billing_statement_id IS NULL
      AND  status IN ('pending', 'waived')
      AND  charge_date BETWEEN p_month_start AND p_month_end
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    v_overage_qty    := GREATEST(0, v_charge.quantity - GREATEST(0, p_new_free_quota - v_consumed));
    v_consumed       := v_consumed + v_charge.quantity;

    v_new_total      := ROUND(v_overage_qty * p_new_cost_per_unit, 2);
    v_gst_amount     := ROUND(v_new_total * v_charge.gst_rate / 100, 2);
    v_total_with_gst := v_new_total + v_gst_amount;

    UPDATE usage_charges
    SET
      -- status is now a usage_charge_status enum (not TEXT) — the CASE's
      -- literal branches need an explicit cast, or Postgres can't resolve
      -- the assignment type.
      status         = (CASE WHEN v_overage_qty > 0 THEN 'pending' ELSE 'waived' END)::usage_charge_status,
      unit_price     = CASE WHEN v_overage_qty > 0 THEN p_new_cost_per_unit ELSE 0 END,
      total          = v_new_total,
      gst_amount     = v_gst_amount,
      total_with_gst = v_total_with_gst
    WHERE id = v_charge.id;
  END LOOP;
END;
$$;

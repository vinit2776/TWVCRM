-- ============================================================
-- Migration 00604: admin rollback for AMC visits, TDS challans and consumption
--
-- Three more steps that were permanent:
--   * an AMC visit logged in error kept using up a covered visit forever
--   * a TDS challan entered wrongly could not be undone, and its TDS entries
--     stayed "deposited"
--   * a voided consumption log could never be restored
--
-- Visits and challans are voided SOFT (row kept, flagged) so numbering and
-- history survive. All three reversals are atomic RPCs, service role only; the
-- API routes check the caller is an admin first.
-- ============================================================

ALTER TABLE amc_service_events
  ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS voided_by     UUID        REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS void_reason   TEXT        DEFAULT NULL;

ALTER TABLE tds_challans
  ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS voided_by     UUID        REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS void_reason   TEXT        DEFAULT NULL;

-- ------------------------------------------------------------
-- void_amc_event
-- Raises: REASON_REQUIRED, EVENT_NOT_FOUND, EVENT_ALREADY_VOIDED
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION void_amc_event(
  p_event_id UUID,
  p_actor    UUID,
  p_reason   TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev      amc_service_events%ROWTYPE;
  v_po      purchase_orders%ROWTYPE;
  v_counted BOOLEAN;
  v_used    INT;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  SELECT * INTO v_ev FROM amc_service_events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'EVENT_NOT_FOUND'; END IF;

  -- Lock the PO first so two voids (or a void and a new visit) serialise on
  -- the visit counter, then re-read the event.
  SELECT * INTO v_po FROM purchase_orders WHERE id = v_ev.po_id FOR UPDATE;
  SELECT * INTO v_ev FROM amc_service_events WHERE id = p_event_id;
  IF v_ev.voided_at IS NOT NULL THEN RAISE EXCEPTION 'EVENT_ALREADY_VOIDED'; END IF;

  UPDATE amc_service_events
     SET voided_at = now(), voided_by = p_actor, void_reason = btrim(p_reason)
   WHERE id = p_event_id;

  -- Same counted types as src/lib/amc-lifecycle.ts (AMC_COUNTED_EVENT_TYPES).
  v_counted := v_ev.event_type IN ('preventive', 'annual_service');
  v_used := COALESCE(v_po.amc_visits_used, 0);

  IF v_counted THEN
    v_used := GREATEST(v_used - 1, 0);
    UPDATE purchase_orders SET amc_visits_used = v_used WHERE id = v_po.id;

    -- An "exhausted" contract that is back under its limit returns to the status
    -- its dates imply (same ordering as 00595).
    IF v_po.amc_status = 'exhausted' AND (v_po.amc_visits_covered IS NULL OR v_used < v_po.amc_visits_covered) THEN
      UPDATE purchase_orders SET amc_status = CASE
        WHEN amc_start_date IS NULL OR amc_start_date > CURRENT_DATE THEN 'inactive'
        WHEN amc_end_date IS NOT NULL AND amc_end_date < CURRENT_DATE THEN 'expired'
        WHEN amc_end_date IS NOT NULL AND (amc_end_date - CURRENT_DATE) <= 60 THEN 'expiring'
        ELSE 'active'
      END WHERE id = v_po.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'po_id', v_po.id,
    'event_number', v_ev.event_number,
    'counted', v_counted,
    'visits_used', v_used,
    'previous_visits_used', COALESCE(v_po.amc_visits_used, 0),
    'was_confirmed', v_ev.confirmed_at IS NOT NULL
  );
END;
$$;

-- ------------------------------------------------------------
-- void_tds_challan
-- Releases every TDS entry on the challan back to pending, then flags the
-- challan voided. Raises: REASON_REQUIRED, CHALLAN_NOT_FOUND, CHALLAN_ALREADY_VOIDED
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION void_tds_challan(
  p_challan_id UUID,
  p_actor      UUID,
  p_reason     TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ch       tds_challans%ROWTYPE;
  v_released INT;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  SELECT * INTO v_ch FROM tds_challans WHERE id = p_challan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHALLAN_NOT_FOUND'; END IF;
  IF v_ch.voided_at IS NOT NULL THEN RAISE EXCEPTION 'CHALLAN_ALREADY_VOIDED'; END IF;

  UPDATE vendor_bill_tds
     SET status = 'pending', challan_id = NULL
   WHERE challan_id = p_challan_id;
  GET DIAGNOSTICS v_released = ROW_COUNT;

  UPDATE tds_challans
     SET voided_at = now(), voided_by = p_actor, void_reason = btrim(p_reason)
   WHERE id = p_challan_id;

  RETURN jsonb_build_object(
    'challan_ref', v_ch.challan_ref,
    'total_amount', v_ch.total_amount,
    'entries_released', v_released
  );
END;
$$;

-- ------------------------------------------------------------
-- unvoid_consumption_log
-- Takes the stock back out and re-activates a voided log, but only if the stock
-- is still there (upsert_location_stock floors at 0, so a silent shortfall would
-- otherwise go unnoticed) and the log was not replaced by a re-log.
-- Raises: REASON_REQUIRED, LOG_NOT_FOUND, NOT_VOIDED, REPLACED_BY_RELOG,
--         INSUFFICIENT_STOCK:<item name>
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION unvoid_consumption_log(
  p_log_id UUID,
  p_actor  UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log   consumption_logs%ROWTYPE;
  v_item  RECORD;
  v_on_hand NUMERIC;
  v_n     INT := 0;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  SELECT * INTO v_log FROM consumption_logs WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LOG_NOT_FOUND'; END IF;
  IF v_log.status <> 'voided' THEN RAISE EXCEPTION 'NOT_VOIDED'; END IF;

  -- A re-log voids the original and creates a replacement; restoring the
  -- original while the replacement is live would count the consumption twice.
  IF EXISTS (
    SELECT 1
      FROM consumption_corrections c
      JOIN consumption_logs nl ON nl.id = c.new_consumption_log_id
     WHERE c.consumption_log_id = p_log_id
       AND c.new_consumption_log_id IS NOT NULL
       AND nl.status = 'active'
  ) THEN
    RAISE EXCEPTION 'REPLACED_BY_RELOG';
  END IF;

  -- Check every item first, locking the stock rows, so nothing is half-applied.
  FOR v_item IN
    SELECT id, item_id, item_name, quantity_consumed
      FROM consumption_log_items
     WHERE consumption_log_id = p_log_id AND item_id IS NOT NULL AND quantity_consumed > 0
  LOOP
    SELECT quantity_on_hand INTO v_on_hand
      FROM location_stock
     WHERE location_id = v_log.location_id AND item_id = v_item.item_id
       FOR UPDATE;
    IF COALESCE(v_on_hand, 0) < v_item.quantity_consumed THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_item.item_name;
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT id, item_id, quantity_consumed
      FROM consumption_log_items
     WHERE consumption_log_id = p_log_id AND item_id IS NOT NULL AND quantity_consumed > 0
  LOOP
    UPDATE location_stock
       SET quantity_on_hand = quantity_on_hand - v_item.quantity_consumed,
           last_updated = now()
     WHERE location_id = v_log.location_id AND item_id = v_item.item_id;
    v_n := v_n + 1;
  END LOOP;

  UPDATE consumption_logs SET status = 'active' WHERE id = p_log_id;

  INSERT INTO consumption_corrections
    (consumption_log_id, consumption_log_item_id, correction_type, reason, original_quantity, new_quantity, corrected_by)
  SELECT p_log_id, i.id, 'unvoid', btrim(p_reason), 0, i.quantity_consumed, p_actor
    FROM consumption_log_items i
   WHERE i.consumption_log_id = p_log_id;

  RETURN jsonb_build_object('log_id', p_log_id, 'items_restored', v_n);
END;
$$;

REVOKE ALL ON FUNCTION void_amc_event(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION void_tds_challan(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION unvoid_consumption_log(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION void_amc_event(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION void_tds_challan(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION unvoid_consumption_log(UUID, UUID, TEXT) TO service_role;

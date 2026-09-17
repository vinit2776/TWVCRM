-- Atomic usage-invoice creation for the contract/month grouped usage billing
-- flow (src/lib/usage-billing.ts).
--
-- The old generator (generateUsageStatements) inserts the statement and then
-- links its charges in separate UPDATEs, so two concurrent sends for the same
-- contract-month could both succeed and bill the same charges twice. This
-- function does the whole thing in one transaction:
--
--   1. Locks every requested charge row (FOR UPDATE).
--   2. Verifies each is still unbilled, not held, not waived, belongs to the
--      contract, and that their amounts still add up to what the caller priced
--      (p_expected_subtotal). Any mismatch raises USAGE_INVOICE_STALE and
--      nothing is written — the caller shows "this changed, refresh".
--   3. Inserts the draft billing_statements row from p_statement.
--   4. Links the charges to it.
--
-- Rollback: DROP FUNCTION create_usage_invoice(jsonb, uuid, uuid[], uuid[], uuid[], numeric);

CREATE OR REPLACE FUNCTION create_usage_invoice(
  p_statement          JSONB,
  p_contract_id        UUID,
  p_usage_charge_ids   UUID[],
  p_service_record_ids UUID[],
  p_facility_record_ids UUID[],
  p_expected_subtotal  NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_usage_ids    UUID[] := COALESCE(p_usage_charge_ids, '{}');
  v_service_ids  UUID[] := COALESCE(p_service_record_ids, '{}');
  v_facility_ids UUID[] := COALESCE(p_facility_record_ids, '{}');
  v_ok_count     INT;
  v_subtotal     NUMERIC := 0;
  v_part         NUMERIC;
  v_statement_id UUID;
BEGIN
  IF cardinality(v_usage_ids) + cardinality(v_service_ids) + cardinality(v_facility_ids) = 0 THEN
    RAISE EXCEPTION 'USAGE_INVOICE_EMPTY: no charges supplied';
  END IF;

  -- 1. Lock
  PERFORM 1 FROM usage_charges          WHERE id = ANY(v_usage_ids)    FOR UPDATE;
  PERFORM 1 FROM service_usage_records  WHERE id = ANY(v_service_ids)  FOR UPDATE;
  PERFORM 1 FROM facility_usage_records WHERE id = ANY(v_facility_ids) FOR UPDATE;

  -- 2. Verify — manual / ad-hoc charges
  SELECT count(*), COALESCE(sum(total), 0) INTO v_ok_count, v_part
  FROM usage_charges
  WHERE id = ANY(v_usage_ids)
    AND contract_id = p_contract_id
    AND status = 'pending'
    AND billing_statement_id IS NULL
    AND held_at IS NULL
    AND total > 0;
  IF v_ok_count <> cardinality(v_usage_ids) THEN
    RAISE EXCEPTION 'USAGE_INVOICE_STALE: a manual charge was billed, held, waived or changed';
  END IF;
  v_subtotal := v_subtotal + v_part;

  -- print / service overage
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_ok_count, v_part
  FROM service_usage_records
  WHERE id = ANY(v_service_ids)
    AND contract_id = p_contract_id
    AND is_billed = false
    AND billing_statement_id IS NULL
    AND held_at IS NULL
    AND waived_at IS NULL
    AND overage_quantity > 0
    AND amount > 0;
  IF v_ok_count <> cardinality(v_service_ids) THEN
    RAISE EXCEPTION 'USAGE_INVOICE_STALE: a print charge was billed, held, waived or changed';
  END IF;
  v_subtotal := v_subtotal + v_part;

  -- facility overage
  SELECT count(*), COALESCE(sum(total_charge), 0) INTO v_ok_count, v_part
  FROM facility_usage_records
  WHERE id = ANY(v_facility_ids)
    AND contract_id = p_contract_id
    AND billing_statement_id IS NULL
    AND held_at IS NULL
    AND waived_at IS NULL
    AND billable_quantity > 0
    AND total_charge > 0;
  IF v_ok_count <> cardinality(v_facility_ids) THEN
    RAISE EXCEPTION 'USAGE_INVOICE_STALE: a facility charge was billed, held, waived or changed';
  END IF;
  v_subtotal := v_subtotal + v_part;

  IF round(v_subtotal, 2) <> round(p_expected_subtotal, 2) THEN
    RAISE EXCEPTION 'USAGE_INVOICE_STALE: amounts changed (expected %, found %)', p_expected_subtotal, v_subtotal;
  END IF;

  IF (p_statement->>'contract_id')::uuid IS DISTINCT FROM p_contract_id THEN
    RAISE EXCEPTION 'USAGE_INVOICE_MISMATCH: statement contract does not match';
  END IF;

  -- 3. Insert the draft statement (id / statement_number come from defaults + trigger)
  INSERT INTO billing_statements (
    contract_id, lead_id, period_start, period_end, due_date, statement_type,
    fixed_amount, usage_amount, service_usage_amount, booking_usage_amount,
    subtotal, tax_percentage, tax_amount, total_amount, status,
    accounting_period_id, cgst_amount, sgst_amount, igst_amount, is_interstate,
    buyer_gstin, place_of_supply, po_number, line_items,
    prepaid_month, prepaid_year, supplements_statement_id
  )
  SELECT
    r.contract_id, r.lead_id, r.period_start, r.period_end, r.due_date, r.statement_type,
    r.fixed_amount, r.usage_amount, r.service_usage_amount, r.booking_usage_amount,
    r.subtotal, r.tax_percentage, r.tax_amount, r.total_amount, r.status,
    r.accounting_period_id, r.cgst_amount, r.sgst_amount, r.igst_amount, r.is_interstate,
    r.buyer_gstin, r.place_of_supply, r.po_number, r.line_items,
    r.prepaid_month, r.prepaid_year, r.supplements_statement_id
  FROM jsonb_populate_record(NULL::billing_statements, p_statement) AS r
  RETURNING id INTO v_statement_id;

  -- 4. Link
  UPDATE usage_charges
    SET billing_statement_id = v_statement_id, status = 'billed'
    WHERE id = ANY(v_usage_ids);
  UPDATE service_usage_records
    SET billing_statement_id = v_statement_id, is_billed = true
    WHERE id = ANY(v_service_ids);
  UPDATE facility_usage_records
    SET billing_statement_id = v_statement_id
    WHERE id = ANY(v_facility_ids);

  RETURN v_statement_id;
END;
$$;

-- Server-only: called with the service-role client from /api/usage-billing/send.
REVOKE ALL ON FUNCTION create_usage_invoice(JSONB, UUID, UUID[], UUID[], UUID[], NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_usage_invoice(JSONB, UUID, UUID[], UUID[], UUID[], NUMERIC) TO service_role;

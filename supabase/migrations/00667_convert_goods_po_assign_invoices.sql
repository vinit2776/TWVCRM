-- Convert a goods-type AMC PO into a service PO and tie EVERY existing invoice to its cycle.
--
-- 00596's convert_goods_po_to_service ties at most one invoice (to cycle 1). A contract
-- billed half-yearly or quarterly can already hold several real invoices on the PO, and
-- after conversion the ones past cycle 1 stayed loose, so the contract read as "cycle 1
-- of 2 invoiced" while cycle 2's invoice sat untied.
--
-- p_assignments is a JSON array of { bill_id, cycle_number, period_from, period_to }.
-- Cycles must be 1..k with no gaps (the cycle engine counts reports and invoices, so a
-- hole would make it offer a cycle that is already billed), each invoice and each cycle
-- used once, and every invoice no more than one cycle's cost. Each assignment backfills
-- that cycle's service report (no report file on record) and ties the invoice to it.
-- Nothing is created for a cycle with no invoice, and no payment, amount or advance is
-- touched. Everything is one transaction.
--
-- 00596's function is left in place and unchanged.
-- Rollback: DROP FUNCTION convert_goods_po_to_service_v2(uuid, uuid, text, integer, numeric, date, jsonb);

CREATE OR REPLACE FUNCTION convert_goods_po_to_service_v2(
  p_po_id          uuid,
  p_user_id        uuid,
  p_billing_cycle  text,
  p_cycle_count    integer,
  p_unit_cost      numeric,
  p_service_start  date,
  p_assignments    jsonb DEFAULT '[]'::jsonb
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  po        purchase_orders%ROWTYPE;
  bill      vendor_bills%ROWTYPE;
  a         jsonb;
  v_role    text;
  v_report  uuid;
  v_n       integer;
  v_cycle   integer;
  v_from    date;
  v_to      date;
  v_done    integer := 0;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  SELECT role::text INTO v_role FROM users WHERE id = p_user_id;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can convert a purchase order to a service contract';
  END IF;

  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF po.po_type <> 'goods' THEN RAISE EXCEPTION 'This purchase order is already a % PO', po.po_type; END IF;
  IF po.status::text NOT IN ('ordered', 'partially_received', 'received', 'invoice_received', 'invoice_approved') THEN
    RAISE EXCEPTION 'A % purchase order cannot be converted', po.status;
  END IF;
  IF po.amc_terminated_at IS NOT NULL THEN RAISE EXCEPTION 'This AMC has been terminated'; END IF;
  IF po.amc_start_date IS NULL AND NOT EXISTS (
       SELECT 1 FROM purchase_requests r
        WHERE r.id = po.pr_id AND (r.expenditure_type::text = 'amc' OR r.department::text = 'amc')) THEN
    RAISE EXCEPTION 'Only AMC contracts can be converted';
  END IF;
  IF EXISTS (SELECT 1 FROM po_service_reports WHERE po_id = po.id) THEN
    RAISE EXCEPTION 'This purchase order already has service reports';
  END IF;

  IF p_billing_cycle NOT IN ('monthly', 'quarterly', 'half_yearly', 'yearly') THEN
    RAISE EXCEPTION 'Unknown billing cycle %', p_billing_cycle;
  END IF;
  IF p_cycle_count IS NULL OR p_cycle_count < 1 THEN RAISE EXCEPTION 'Cycle count must be at least 1'; END IF;
  IF p_unit_cost IS NULL OR p_unit_cost <= 0 THEN RAISE EXCEPTION 'Cost per cycle must be more than zero'; END IF;
  IF abs(p_unit_cost * p_cycle_count - po.total_ordered_amount) > 0.01 THEN
    RAISE EXCEPTION '% cycles of % does not add up to the PO total of %', p_cycle_count, p_unit_cost, po.total_ordered_amount;
  END IF;
  IF p_service_start IS NULL THEN RAISE EXCEPTION 'A start date is required'; END IF;

  v_n := COALESCE(jsonb_array_length(p_assignments), 0);
  IF v_n > p_cycle_count THEN
    RAISE EXCEPTION 'More invoices (%) than cycles (%)', v_n, p_cycle_count;
  END IF;
  -- Cycles 1..v_n, each exactly once: the count and the distinct-in-range count both equal v_n.
  IF v_n > 0 AND (
       SELECT count(DISTINCT (e->>'cycle_number')::int)
         FROM jsonb_array_elements(p_assignments) e
        WHERE (e->>'cycle_number')::int BETWEEN 1 AND v_n
     ) <> v_n THEN
    RAISE EXCEPTION 'Invoices must be tied to cycles 1 to % with no gaps and no cycle used twice', v_n;
  END IF;
  IF v_n > 0 AND (
       SELECT count(DISTINCT e->>'bill_id') FROM jsonb_array_elements(p_assignments) e
     ) <> v_n THEN
    RAISE EXCEPTION 'The same invoice was chosen for two cycles';
  END IF;

  UPDATE purchase_orders
     SET po_type = 'service',
         billing_cycle = p_billing_cycle,
         cycle_count = p_cycle_count,
         unit_cost_per_cycle = p_unit_cost,
         service_start_date = p_service_start,
         status = 'ordered'
   WHERE id = po.id;

  FOR a IN SELECT e FROM jsonb_array_elements(p_assignments) e
            ORDER BY (e->>'cycle_number')::int
  LOOP
    v_cycle := (a->>'cycle_number')::int;
    v_from  := (a->>'period_from')::date;
    v_to    := (a->>'period_to')::date;

    SELECT * INTO bill FROM vendor_bills WHERE id = (a->>'bill_id')::uuid AND po_id = po.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'An invoice for cycle % is not on this purchase order', v_cycle; END IF;
    IF bill.approval_status = 'rejected' THEN RAISE EXCEPTION 'A rejected invoice cannot be used for cycle %', v_cycle; END IF;
    IF bill.service_report_id IS NOT NULL THEN RAISE EXCEPTION 'The invoice for cycle % is already tied to a cycle', v_cycle; END IF;
    IF bill.total_amount > p_unit_cost + 0.01 THEN
      RAISE EXCEPTION 'The invoice for cycle % (%) is more than one cycle''s cost (%)', v_cycle, bill.total_amount, p_unit_cost;
    END IF;
    IF v_from IS NULL OR v_to IS NULL OR v_from > v_to THEN
      RAISE EXCEPTION 'Enter the cycle % period (from on or before to)', v_cycle;
    END IF;

    INSERT INTO po_service_reports (po_id, cycle_number, period_from, period_to, report_file_url, notes, recorded_by)
    VALUES (po.id, v_cycle, v_from, v_to, NULL,
            'Backfilled when this goods-type AMC PO was converted to a service PO. No vendor report file on record.',
            p_user_id)
    RETURNING id INTO v_report;

    UPDATE vendor_bills SET service_report_id = v_report WHERE id = bill.id;

    INSERT INTO audit_trail (entity_type, entity_id, action, performed_by, changes)
    VALUES ('vendor_bill', bill.id, 'update', p_user_id,
            jsonb_build_object('service_report_id', jsonb_build_object('old', NULL, 'new', v_report)));

    v_changes := v_changes || jsonb_build_object('cycle_' || v_cycle || '_bill', jsonb_build_object('old', NULL, 'new', bill.id));
    v_done := v_done + 1;
  END LOOP;

  INSERT INTO audit_trail (entity_type, entity_id, action, performed_by, changes)
  VALUES ('purchase_order', po.id, 'update', p_user_id, v_changes || jsonb_build_object(
    '_conversion',         jsonb_build_object('old', NULL, 'new', 'goods_to_service_amc'),
    'po_type',             jsonb_build_object('old', po.po_type, 'new', 'service'),
    'status',              jsonb_build_object('old', po.status, 'new', 'ordered'),
    'billing_cycle',       jsonb_build_object('old', po.billing_cycle, 'new', p_billing_cycle),
    'cycle_count',         jsonb_build_object('old', po.cycle_count, 'new', p_cycle_count),
    'unit_cost_per_cycle', jsonb_build_object('old', po.unit_cost_per_cycle, 'new', p_unit_cost),
    'service_start_date',  jsonb_build_object('old', po.service_start_date, 'new', p_service_start),
    'invoices_tied',       jsonb_build_object('old', 0, 'new', v_done)));

  RETURN v_done;
END $$;

REVOKE ALL ON FUNCTION convert_goods_po_to_service_v2(uuid, uuid, text, integer, numeric, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION convert_goods_po_to_service_v2(uuid, uuid, text, integer, numeric, date, jsonb) TO service_role;

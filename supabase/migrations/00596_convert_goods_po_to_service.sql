-- Converts an AMC that was raised as a goods PO into a service PO, so it gets cycle
-- billing (service report + one invoice per cycle). Admin-only action behind
-- POST /api/procurement/orders/[id]/convert-to-service.
--
-- One function = one transaction: the PO change, the cycle-1 report, tying an existing
-- invoice to it, and the audit rows all happen together or not at all.
--
-- It only changes the PO's type/cycle fields and status, optionally creates the cycle-1
-- service report and links ONE existing invoice to it. It never touches amounts, payments,
-- the advance, delivery receipts or any other invoice.
--
-- The audit row records the OLD values under the same keys the manual conversion script
-- used, so ops/po-2604-045/2_rollback.sql style rollbacks work on these too.
--
-- Rollback of this migration: DROP FUNCTION convert_goods_po_to_service(uuid, uuid, text, integer, numeric, date, uuid, date, date);

CREATE OR REPLACE FUNCTION convert_goods_po_to_service(
  p_po_id          uuid,
  p_user_id        uuid,
  p_billing_cycle  text,
  p_cycle_count    integer,
  p_unit_cost      numeric,
  p_service_start  date,
  p_bill_id        uuid DEFAULT NULL,
  p_c1_from        date DEFAULT NULL,
  p_c1_to          date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  po       purchase_orders%ROWTYPE;
  bill     vendor_bills%ROWTYPE;
  v_role   text;
  v_report uuid := NULL;
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

  IF p_bill_id IS NOT NULL THEN
    SELECT * INTO bill FROM vendor_bills WHERE id = p_bill_id AND po_id = po.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That invoice is not on this purchase order'; END IF;
    IF bill.approval_status = 'rejected' THEN RAISE EXCEPTION 'A rejected invoice cannot be used for cycle 1'; END IF;
    IF bill.service_report_id IS NOT NULL THEN RAISE EXCEPTION 'That invoice is already tied to a cycle'; END IF;
    IF bill.total_amount > p_unit_cost + 0.01 THEN
      RAISE EXCEPTION 'That invoice (%) is more than one cycle''s cost (%)', bill.total_amount, p_unit_cost;
    END IF;
    IF p_c1_from IS NULL OR p_c1_to IS NULL OR p_c1_from > p_c1_to THEN
      RAISE EXCEPTION 'Enter the cycle 1 period (from on or before to)';
    END IF;
  END IF;

  UPDATE purchase_orders
     SET po_type = 'service',
         billing_cycle = p_billing_cycle,
         cycle_count = p_cycle_count,
         unit_cost_per_cycle = p_unit_cost,
         service_start_date = p_service_start,
         status = 'ordered'
   WHERE id = po.id;

  IF p_bill_id IS NOT NULL THEN
    INSERT INTO po_service_reports (po_id, cycle_number, period_from, period_to, report_file_url, notes, recorded_by)
    VALUES (po.id, 1, p_c1_from, p_c1_to, NULL,
            'Backfilled when this goods-type AMC PO was converted to a service PO. No vendor report file on record.',
            p_user_id)
    RETURNING id INTO v_report;

    UPDATE vendor_bills SET service_report_id = v_report WHERE id = bill.id;

    INSERT INTO audit_trail (entity_type, entity_id, action, performed_by, changes)
    VALUES ('vendor_bill', bill.id, 'update', p_user_id,
            jsonb_build_object('service_report_id', jsonb_build_object('old', NULL, 'new', v_report)));
  END IF;

  INSERT INTO audit_trail (entity_type, entity_id, action, performed_by, changes)
  VALUES ('purchase_order', po.id, 'update', p_user_id, jsonb_build_object(
    '_conversion',         jsonb_build_object('old', NULL, 'new', 'goods_to_service_amc'),
    'po_type',             jsonb_build_object('old', po.po_type, 'new', 'service'),
    'status',              jsonb_build_object('old', po.status, 'new', 'ordered'),
    'billing_cycle',       jsonb_build_object('old', po.billing_cycle, 'new', p_billing_cycle),
    'cycle_count',         jsonb_build_object('old', po.cycle_count, 'new', p_cycle_count),
    'unit_cost_per_cycle', jsonb_build_object('old', po.unit_cost_per_cycle, 'new', p_unit_cost),
    'service_start_date',  jsonb_build_object('old', po.service_start_date, 'new', p_service_start),
    'service_report_id',   jsonb_build_object('old', NULL, 'new', v_report)));

  RETURN v_report;
END $$;

-- Only the server (service role) calls this; the route checks the admin role first and
-- the function checks it again.
REVOKE ALL ON FUNCTION convert_goods_po_to_service(uuid, uuid, text, integer, numeric, date, uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION convert_goods_po_to_service(uuid, uuid, text, integer, numeric, date, uuid, date, date) TO service_role;

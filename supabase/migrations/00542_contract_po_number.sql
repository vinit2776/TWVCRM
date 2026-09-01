-- Customer PO number — some customers issue an annual purchase order for
-- their contract and require it printed on every Proforma/GST invoice for
-- their own invoice processing. Collected once on the contract and snapshotted
-- onto each billing_statement at generation time, so an invoice already sent
-- doesn't silently change if the contract's PO number is edited later.

ALTER TABLE contracts
  ADD COLUMN po_number TEXT;

ALTER TABLE billing_statements
  ADD COLUMN po_number TEXT;

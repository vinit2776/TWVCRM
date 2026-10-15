-- The Process Advance route (PATCH /api/procurement/orders/[id], action process_advance)
-- accepts cash, bank_transfer, neft, rtgs, imps and cheque, but
-- purchase_orders.advance_payment_mode has carried the CHECK constraint from migration
-- 00056 listing only cash / upi / bank_transfer. Recording an advance by NEFT, RTGS, IMPS
-- or cheque therefore failed at the database. Widen it; 'upi' stays so existing rows remain valid.

ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS po_advance_mode_check;

ALTER TABLE purchase_orders
  ADD CONSTRAINT po_advance_mode_check
  CHECK (advance_payment_mode IN ('cash', 'upi', 'bank_transfer', 'neft', 'rtgs', 'imps', 'cheque'));

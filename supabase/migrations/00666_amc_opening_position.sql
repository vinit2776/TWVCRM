-- Opening position for an AMC that was already running when it was entered here.
--
-- A contract signed before this system existed has cycles that were billed and paid
-- elsewhere. Rather than invent past invoices (the bill form rejects past dates, and
-- cycles are counted from reports and invoices filed), the request and the service PO
-- record how far the contract had got:
--
--   opening_cycles  cycles already billed and settled before this system. Cycle numbers
--                   on screen continue from here ("cycle 2 of 2").
--   opening_visits  preventive / annual visits already done. The PO starts its
--                   amc_visits_used counter from this number.
--
-- cycle_count and the request's line quantity stay the cycles still to be billed HERE,
-- so approval, the budget, the PO value and the bill ceiling all count the remaining
-- spend with no change. The full contract is opening_cycles + cycle_count cycles.
--
-- Both columns default to 0, so every existing request and PO behaves exactly as before.
--
-- Rollback: ALTER TABLE purchase_requests DROP COLUMN opening_cycles, DROP COLUMN opening_visits;
--           ALTER TABLE purchase_orders   DROP COLUMN opening_cycles, DROP COLUMN opening_visits;

ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS opening_cycles integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_visits integer NOT NULL DEFAULT 0;

ALTER TABLE purchase_requests
  ADD CONSTRAINT purchase_requests_opening_cycles_check CHECK (opening_cycles >= 0),
  ADD CONSTRAINT purchase_requests_opening_visits_check CHECK (opening_visits >= 0);

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS opening_cycles integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_visits integer NOT NULL DEFAULT 0;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_opening_cycles_check CHECK (opening_cycles >= 0),
  ADD CONSTRAINT purchase_orders_opening_visits_check CHECK (opening_visits >= 0);

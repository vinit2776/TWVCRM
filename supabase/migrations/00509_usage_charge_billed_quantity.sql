-- usage_charges.quantity is overloaded: on the checkout pooled-usage path
-- (maybePostPooledUsageCharge, src/app/api/bookings/[id]/route.ts) it stores
-- the full consumed duration and is summed to drive free-quota accounting
-- (hoursConsumedSoFar). On other paths (manual entry, procurement
-- reimbursement, service imports) it stores billable units where
-- quantity * unit_price == total. Because the invoice PDF renders a single
-- Qty column, the pooled-usage path was producing invoice lines whose
-- Qty x Unit Price didn't equal Total.
--
-- billed_quantity is the new, unambiguous column: what the customer is
-- actually charged for, always satisfying billed_quantity * unit_price ==
-- total. It is nullable because historical rows predate this column and
-- have no value — callers/renderers must fall back to `quantity` when it
-- is NULL. `quantity` itself is untouched and keeps its existing meaning
-- (consumption ledger) so free-quota math is unaffected.
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS billed_quantity DECIMAL(10, 2);

COMMENT ON COLUMN usage_charges.quantity IS
  'What was consumed. Drives free-quota accounting (e.g. hoursConsumedSoFar pooling on the checkout path) — do not use for invoice Qty display.';

COMMENT ON COLUMN usage_charges.billed_quantity IS
  'What the customer is actually charged for; billed_quantity * unit_price == total. Nullable — historical rows predate this column and have no value, so invoice rendering must fall back to `quantity` when this is NULL.';

-- usage_charges already has RLS enabled with full CRUD policies for the
-- `authenticated` role (see 00002_contracts_billing.sql). A nullable
-- column addition needs no new policy.

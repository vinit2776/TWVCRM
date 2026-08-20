-- Delivery receipts can now be "reversed" without being deleted.
--
-- Two flows share the same stock/quantity_received reversal logic
-- (src/lib/procurement/reverse-delivery.ts), but they have different
-- retention needs:
--   1. Delivery-reject (DELETE /api/procurement/orders/[id]/deliveries) is
--      the correction of an erroneous entry (wrong qty, wrong item) — the
--      receipt row is deleted, same as before this migration.
--   2. PO force-cancel (case "cancel" in
--      /api/procurement/orders/[id]/route.ts) is a real business event: the
--      PO is cancelled AFTER goods were genuinely received. Deleting the
--      delivery challan there would erase the historical record that goods
--      physically arrived, so those rows are now kept and stamped as
--      reversed instead.
--
-- reversed_at IS NULL means "this is a live receipt whose stock effect is
-- still in force" — every reader that treats a row as live goods (stock
-- aging, invoice-cap calculations, "has a delivery been recorded" checks)
-- must filter on reversed_at IS NULL. Historical/audit views (bill chain,
-- lifecycle timeline) may still show reversed rows, since the delivery did
-- happen — they should just select reversed_at so the UI can mark it.
--
-- Nullable, no default: existing rows are implicitly live (reversed_at NULL)
-- and nothing populates these columns except the new "retain" disposition
-- of reverseDeliveryReceipt().
--
-- Rollback: DROP COLUMN reversed_at, reversed_by, reversal_reason from
-- po_delivery_receipts (all three are nullable with no default, so dropping
-- them is non-destructive to any other column and safe to run at any time).
ALTER TABLE po_delivery_receipts
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

COMMENT ON COLUMN po_delivery_receipts.reversed_at IS
  'When this receipt''s stock/quantity_received effect was reversed (e.g. PO force-cancel). NULL means the receipt is live and its stock effect still stands.';
COMMENT ON COLUMN po_delivery_receipts.reversed_by IS
  'User who performed the reversal (e.g. the admin/manager who force-cancelled the PO). NULL when reversed_at is NULL.';
COMMENT ON COLUMN po_delivery_receipts.reversal_reason IS
  'Why the receipt was reversed (e.g. the PO cancellation reason). NULL when reversed_at is NULL.';

-- No RLS policy changes needed — po_delivery_receipts already has RLS
-- enabled (see 00028_delivery_receipts.sql) with a table-level
-- "authenticated_all" policy; these are plain columns, not a new table, and
-- column-level RLS is not in use anywhere in this schema.

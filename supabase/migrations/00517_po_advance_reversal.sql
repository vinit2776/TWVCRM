-- ==========================================
-- Migration 00517: PO Advance Reversal
-- ==========================================
-- A processed PO advance (advance_status = 'processed') is a HARD BLOCKER on
-- cancelling a purchase order or its parent material request (see
-- src/lib/procurement/cancellation-plan.ts, processedAdvanceBlocker) — that
-- money has already left the business, so cancellation cannot silently
-- disappear it. Before this migration there was no way to clear that block:
-- a PO with a processed advance could never be cancelled. This migration
-- adds a `reversed` advance_status and the columns needed to record how the
-- advance was reversed, so the blocker can be resolved and then cleared.
--
-- Three reversal modes (advance_reversal_mode):
--   - refund_received: the vendor actually returned the money. Symmetric
--     with how the advance was paid — process_advance
--     (src/app/api/procurement/orders/[id]/route.ts) never debits a ledger
--     table (petty_cash_books, or any other) for the advance, it only sets
--     columns on this PO row, so reversal likewise only touches PO columns
--     and does not need to credit any ledger back.
--   - adjusted: the advance was set off against a vendor bill/invoice
--     instead of being physically returned — no cash movement either way.
--   - written_off: the business is accepting the loss (vendor default,
--     dispute, etc.). This is the only mode with real P&L impact and no
--     corroborating money movement, so it additionally requires a second
--     pair of eyes: advance_writeoff_reviewed_at/by, populated by the
--     write-off review queue (GET/PATCH
--     src/app/api/procurement/advances/writeoffs/route.ts). The reviewer
--     must not be the same person who recorded the reversal (self-review
--     defeats the control) — enforced in that route, not in SQL.
--
-- Rollback: drop the new columns and the partial index, then recreate
-- po_advance_status_check with the original 3-value list (only safe if no
-- row has advance_status = 'reversed' at rollback time):
--   DROP INDEX IF EXISTS idx_purchase_orders_advance_writeoff_pending_review;
--   ALTER TABLE purchase_orders
--     DROP COLUMN IF EXISTS advance_reversed_at,
--     DROP COLUMN IF EXISTS advance_reversed_by,
--     DROP COLUMN IF EXISTS advance_reversal_reason,
--     DROP COLUMN IF EXISTS advance_reversal_mode,
--     DROP COLUMN IF EXISTS advance_writeoff_reviewed_at,
--     DROP COLUMN IF EXISTS advance_writeoff_reviewed_by;
--   ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS po_advance_status_check;
--   ALTER TABLE purchase_orders
--     ADD CONSTRAINT po_advance_status_check CHECK (advance_status IN ('not_required', 'pending', 'processed'));

-- Widen advance_status to allow 'reversed'. Keep the exact constraint name
-- (po_advance_status_check, defined in 00056_po_advance_payment.sql) so
-- nothing that references it by name breaks.
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS po_advance_status_check;
ALTER TABLE purchase_orders
  ADD CONSTRAINT po_advance_status_check CHECK (advance_status IN ('not_required', 'pending', 'processed', 'reversed'));

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS advance_reversed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS advance_reversed_by             UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS advance_reversal_reason          TEXT,
  ADD COLUMN IF NOT EXISTS advance_reversal_mode            TEXT
    CONSTRAINT po_advance_reversal_mode_check CHECK (advance_reversal_mode IS NULL OR advance_reversal_mode IN ('refund_received', 'adjusted', 'written_off')),
  ADD COLUMN IF NOT EXISTS advance_writeoff_reviewed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS advance_writeoff_reviewed_by     UUID REFERENCES users(id);

-- Supports the Finance write-off review queue: written-off advances not yet
-- reviewed by a second person. Partial so the index stays tiny — most rows
-- never touch this path at all.
CREATE INDEX IF NOT EXISTS idx_purchase_orders_advance_writeoff_pending_review
  ON purchase_orders (advance_reversed_at)
  WHERE advance_reversal_mode = 'written_off' AND advance_writeoff_reviewed_at IS NULL;

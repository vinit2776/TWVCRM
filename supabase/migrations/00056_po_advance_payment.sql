-- ==========================================
-- Migration 00056: PO Advance Payment
-- ==========================================
-- Adds advance payment fields to purchase_orders.
-- Advance is captured at PO creation time; accounts processes it immediately.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS advance_amount             DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS advance_payment_mode       TEXT
    CONSTRAINT po_advance_mode_check CHECK (advance_payment_mode IN ('cash', 'upi', 'bank_transfer')),
  ADD COLUMN IF NOT EXISTS advance_payment_reference  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS advance_notes              TEXT,
  ADD COLUMN IF NOT EXISTS advance_status             TEXT NOT NULL DEFAULT 'not_required'
    CONSTRAINT po_advance_status_check CHECK (advance_status IN ('not_required', 'pending', 'processed')),
  ADD COLUMN IF NOT EXISTS advance_processed_by       UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS advance_processed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS advance_payment_date       DATE;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_advance_status ON purchase_orders(advance_status);

-- ============================================================
-- Migration 00294: Link vendor bill cash payments to petty cash books
-- ============================================================

ALTER TABLE vendor_bill_payments
  ADD COLUMN IF NOT EXISTS petty_cash_book_id UUID REFERENCES petty_cash_books(id);

CREATE INDEX IF NOT EXISTS idx_vendor_bill_payments_pc_book
  ON vendor_bill_payments(petty_cash_book_id);

-- Migration 00160: Payment hold mechanism for vendor bills
-- Accounts users can place a payment on hold with a structured reason.
-- Approvers (admin/manager) are notified and can release the hold.

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS payment_hold_status     TEXT    DEFAULT 'none'
    CHECK (payment_hold_status IN ('none', 'on_hold')),
  ADD COLUMN IF NOT EXISTS payment_hold_reason     TEXT    DEFAULT NULL
    CHECK (payment_hold_reason IS NULL OR payment_hold_reason IN (
      'wrong_scan', 'wrong_bank_details', 'bank_rejected',
      'amount_mismatch', 'duplicate_suspected', 'pending_docs', 'other'
    )),
  ADD COLUMN IF NOT EXISTS payment_hold_notes      TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payment_held_by         UUID    REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS payment_held_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_hold_resolved_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS payment_hold_resolved_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_hold_resolution_notes TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_bills_hold_status
  ON vendor_bills(payment_hold_status)
  WHERE payment_hold_status = 'on_hold';

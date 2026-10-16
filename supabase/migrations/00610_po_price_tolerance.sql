-- ============================================================
-- Migration 00610: price tolerance on purchase requests / orders / bills
--
-- A requester can ask for room (up to 10%) between the estimate and the final
-- vendor invoice; whoever approves the request accepts or changes it; the PO
-- inherits the approved figure; a bill outside that band is flagged and needs
-- an explicit admin acknowledgement before it can be approved.
--
-- Rollback: drop the added columns/constraints below (all additive, all
-- defaulting to "firm price", so existing rows behave exactly as before).
-- ============================================================

ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS tolerance_requested_percent SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tolerance_reason            TEXT,
  ADD COLUMN IF NOT EXISTS tolerance_percent           SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tolerance_decided_by        UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS tolerance_decided_at        TIMESTAMPTZ;

ALTER TABLE purchase_requests
  ADD CONSTRAINT purchase_requests_tolerance_requested_range
    CHECK (tolerance_requested_percent BETWEEN 0 AND 10),
  ADD CONSTRAINT purchase_requests_tolerance_range
    CHECK (tolerance_percent BETWEEN 0 AND 10);

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS tolerance_percent SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_tolerance_range
    CHECK (tolerance_percent BETWEEN 0 AND 10);

ALTER TABLE vendor_bills
  -- Signed difference between the invoice and the PO value it was checked against.
  ADD COLUMN IF NOT EXISTS variance_amount           NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS variance_percent          NUMERIC(7,2),
  ADD COLUMN IF NOT EXISTS out_of_tolerance          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tolerance_exception_reason TEXT,
  ADD COLUMN IF NOT EXISTS tolerance_acknowledged_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS tolerance_acknowledged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_vendor_bills_out_of_tolerance
  ON vendor_bills (out_of_tolerance) WHERE out_of_tolerance;

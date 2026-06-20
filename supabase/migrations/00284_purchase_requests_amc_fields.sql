-- AMC fields on purchase_requests
-- ─────────────────────────────────────────────────────────────────────────────
-- Folds the AMC PO flow into the standard MR → PO procurement flow.
-- When department='amc', the MR carries the full AMC contract shape (asset,
-- coverage, dates, visits, L1/L2/L3 contacts, advance request) so the PO
-- creation step can pre-fill from the approved MR.

ALTER TABLE purchase_requests
  -- Service identity
  ADD COLUMN IF NOT EXISTS service_item_name      TEXT,
  ADD COLUMN IF NOT EXISTS linked_asset_id        UUID REFERENCES facility_assets(id) ON DELETE SET NULL,

  -- AMC coverage & dates
  ADD COLUMN IF NOT EXISTS amc_coverage_type      TEXT
    CHECK (amc_coverage_type IN ('comprehensive', 'labour_only')),
  ADD COLUMN IF NOT EXISTS amc_start_date         DATE,
  ADD COLUMN IF NOT EXISTS amc_end_date           DATE,
  ADD COLUMN IF NOT EXISTS amc_visits_covered     INTEGER,   -- NULL = unlimited

  -- Contacts (L1 primary, L2 + L3 escalation)
  ADD COLUMN IF NOT EXISTS amc_contact_name       TEXT,
  ADD COLUMN IF NOT EXISTS amc_helpline_number    TEXT,
  ADD COLUMN IF NOT EXISTS amc_contact_email      TEXT,
  ADD COLUMN IF NOT EXISTS amc_escalation_name    TEXT,
  ADD COLUMN IF NOT EXISTS amc_escalation_phone   TEXT,
  ADD COLUMN IF NOT EXISTS amc_escalation2_name   TEXT,
  ADD COLUMN IF NOT EXISTS amc_escalation2_phone  TEXT,

  -- Advance request (PR-level — admin will still approve on the PO)
  ADD COLUMN IF NOT EXISTS advance_amount         DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS advance_payment_mode   TEXT
    CHECK (advance_payment_mode IN ('neft', 'rtgs', 'imps', 'bank_transfer', 'cheque', 'cash')),
  ADD COLUMN IF NOT EXISTS advance_notes          TEXT;

CREATE INDEX IF NOT EXISTS idx_purchase_requests_linked_asset
  ON purchase_requests(linked_asset_id)
  WHERE linked_asset_id IS NOT NULL;

COMMENT ON COLUMN purchase_requests.service_item_name IS
  'For department=amc/service MRs — single service line description';
COMMENT ON COLUMN purchase_requests.amc_visits_covered IS
  'NULL means unlimited visits';

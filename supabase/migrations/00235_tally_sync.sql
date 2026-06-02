-- Migration: Tally integration sync infrastructure (Phase 1)
--
-- Adds:
--   1. tally_sync_jobs     — outbox queue; bridge polls this, acks back
--   2. tally_bridge_health — heartbeat from the bridge agent (one row)
--   3. Tally mirror columns on billing_statements
--   4. Tally mirror columns on gst_invoices
--   5. ALTERID cursor on tally_sync_jobs (Phase 2 manual-receipt reads)
--
-- Design notes:
--   - billing_statements.tally_sync_status drives the CRM dashboard flag
--   - gst_invoices.irn / ack_no / signed_qr_code are now MIRRORS of what
--     Tally returns, not CRM-generated. The e-invoice/* routes are parked.
--   - tally_sync_jobs is the single source of pending work; the bridge holds
--     a lease (claimed_at + expires_at) so a crash re-exposes the job.
--   - ALTERID cursor (tally_receipt_alterid_cursor) is stored here so Phase 2
--     manual-receipt reading has a durable high-water mark without re-migrating.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. tally_sync_jobs  (the outbox queue)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tally_sync_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What type of sync work this is
  job_type          TEXT        NOT NULL
    CONSTRAINT tally_sync_jobs_job_type_check
      CHECK (job_type IN ('sales_voucher', 'party_master', 'receipt_voucher', 'credit_note')),

  -- Source record this job belongs to (polymorphic)
  billing_statement_id UUID     REFERENCES billing_statements(id) ON DELETE CASCADE,
  gst_invoice_id    UUID        REFERENCES gst_invoices(id) ON DELETE SET NULL,

  -- Job lifecycle
  --   pending    → bridge hasn't picked it up yet
  --   claimed    → bridge is working on it (lease held)
  --   posted     → sent to Tally, waiting for ack
  --   completed  → ack received, mirrors written
  --   failed     → hard failure, needs human attention + Retry
  status            TEXT        NOT NULL DEFAULT 'pending'
    CONSTRAINT tally_sync_jobs_status_check
      CHECK (status IN ('pending', 'claimed', 'posted', 'completed', 'failed')),

  -- Lease fields — bridge claims a job for up to lease_duration_seconds.
  -- If the bridge crashes, the job re-surfaces after claimed_at + lease expires.
  claimed_at        TIMESTAMPTZ,
  lease_expires_at  TIMESTAMPTZ,
  claimed_by        TEXT,           -- bridge instance ID (for multi-instance safety)

  -- Attempt tracking
  attempt_count     INT         NOT NULL DEFAULT 0,
  max_attempts      INT         NOT NULL DEFAULT 5,
  last_attempted_at TIMESTAMPTZ,
  last_error        TEXT,           -- human-readable last failure reason (IRP error, etc.)

  -- Idempotency key — deterministic, stamped on Tally voucher.
  -- bridge does check-before-create using this key.
  -- Format: job_type:billing_statement_id (or gst_invoice_id for CRN)
  idempotency_key   TEXT        NOT NULL UNIQUE,

  -- Payload sent to Tally (taxable values + ledger mapping; Tally computes tax)
  payload           JSONB       NOT NULL DEFAULT '{}',

  -- Result written back by bridge on success
  tally_voucher_guid    TEXT,       -- Tally's internal voucher ID
  tally_invoice_number  TEXT,       -- GST invoice number Tally assigned
  tally_irn             TEXT,       -- IRN from IRP (via Tally)
  tally_ack_no          TEXT,
  tally_ack_date        TEXT,
  tally_signed_qr_code  TEXT,
  tally_pdf_path        TEXT,       -- path in Supabase storage after pdf-lib overlay

  -- IRN-aging alarm support (D10.4 — legal 30-day IRN clock)
  -- Set when voucher is created in Tally but IRN is still pending
  voucher_created_at    TIMESTAMPTZ,
  irn_alarm_sent_at     TIMESTAMPTZ,  -- null = alarm not yet fired

  -- Phase 2: ALTERID cursor (D10.5)
  -- Stores the Tally ALTERID high-water mark for manual receipt reads.
  -- Only populated on receipt_voucher jobs read FROM Tally.
  tally_alterid         BIGINT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

-- Fast poll: bridge asks "any pending jobs?" — must be instant
CREATE INDEX IF NOT EXISTS tally_sync_jobs_status_idx
  ON tally_sync_jobs (status)
  WHERE status IN ('pending', 'claimed', 'failed');

-- Fast lookup by billing statement (CRM dashboard)
CREATE INDEX IF NOT EXISTS tally_sync_jobs_billing_statement_idx
  ON tally_sync_jobs (billing_statement_id);

-- Fast lease expiry check (re-surface crashed-bridge jobs)
CREATE INDEX IF NOT EXISTS tally_sync_jobs_lease_idx
  ON tally_sync_jobs (lease_expires_at)
  WHERE status = 'claimed';

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_tally_sync_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tally_sync_jobs_updated_at
  BEFORE UPDATE ON tally_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION update_tally_sync_jobs_updated_at();

-- RLS
ALTER TABLE tally_sync_jobs ENABLE ROW LEVEL SECURITY;

-- No user-session access — only the service role (bridge API endpoints)
-- uses this table. Authenticated users can read their own statement's job
-- for the dashboard status indicator.
CREATE POLICY "tally_sync_jobs_read_own"
  ON tally_sync_jobs FOR SELECT
  TO authenticated
  USING (
    billing_statement_id IN (
      SELECT bs.id FROM billing_statements bs
      JOIN contracts c ON c.id = bs.contract_id
      WHERE c.lead_id IN (
        SELECT id FROM leads
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. tally_bridge_health  (heartbeat — one row per bridge instance)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tally_bridge_health (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_instance_id  TEXT    NOT NULL UNIQUE,   -- set by the agent at startup
  version             TEXT,                       -- bridge version string e.g. "1.0.0"
  tally_connected     BOOLEAN NOT NULL DEFAULT false,
  tally_company_name  TEXT,                       -- currently open company in Tally
  tally_company_gstin TEXT,                       -- confirmed GSTIN match
  crm_connected       BOOLEAN NOT NULL DEFAULT true,
  pending_count       INT     NOT NULL DEFAULT 0,
  failed_count        INT     NOT NULL DEFAULT 0,
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at        TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tally_bridge_health ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read bridge health (for the dashboard card)
CREATE POLICY "tally_bridge_health_read"
  ON tally_bridge_health FOR SELECT
  TO authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. billing_statements — Tally mirror columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS tally_sync_status TEXT DEFAULT 'not_applicable'
    CONSTRAINT billing_statements_tally_sync_status_check
      CHECK (tally_sync_status IN (
        'not_applicable',  -- statement doesn't need Tally sync (e.g. voided before finalize)
        'pending',         -- finalized, waiting for bridge to pick up
        'in_progress',     -- bridge has claimed the job
        'issued',          -- Tally issued invoice number + IRN; mirrors written
        'failed'           -- hard failure, needs attention
      )),
  ADD COLUMN IF NOT EXISTS tally_sync_job_id     UUID REFERENCES tally_sync_jobs(id),
  ADD COLUMN IF NOT EXISTS tally_invoice_number  TEXT,   -- GST invoice number from Tally
  ADD COLUMN IF NOT EXISTS tally_voucher_guid    TEXT,   -- Tally's internal GUID
  ADD COLUMN IF NOT EXISTS tally_synced_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tally_last_error      TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_tally_link_id TEXT,  -- the link created from Tally total
  ADD COLUMN IF NOT EXISTS razorpay_tally_link_url TEXT;

-- Index for dashboard: "show me statements with sync issues"
CREATE INDEX IF NOT EXISTS billing_statements_tally_sync_status_idx
  ON billing_statements (tally_sync_status)
  WHERE tally_sync_status IN ('pending', 'in_progress', 'failed');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. gst_invoices — Tally mirror columns
--    irn / ack_no / signed_qr_code already exist; these are now MIRRORS
--    of what Tally returns. Added: tally_voucher_guid for the cross-reference.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE gst_invoices
  ADD COLUMN IF NOT EXISTS tally_voucher_guid    TEXT,
  ADD COLUMN IF NOT EXISTS tally_synced_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sourced_from_tally    BOOLEAN NOT NULL DEFAULT false;
  -- sourced_from_tally = true means irn/ack_no/signed_qr_code came from Tally,
  -- not from the CRM's own e-invoice generation. Guards against double-minting.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. app_settings seed — ledger mapping config keys
--    Actual values to be filled by admin once Tally ledger names are confirmed.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings (key, value, description) VALUES
  ('tally_ledger_rent_income',    '',   'Tally ledger name for space rent income'),
  ('tally_ledger_usage_income',   '',   'Tally ledger name for usage/ad-hoc income'),
  ('tally_ledger_cgst_output',    '',   'Tally ledger name for Output CGST'),
  ('tally_ledger_sgst_output',    '',   'Tally ledger name for Output SGST'),
  ('tally_ledger_igst_output',    '',   'Tally ledger name for Output IGST'),
  ('tally_ledger_round_off',      '',   'Tally ledger name for round-off'),
  ('tally_party_ledger_suffix',   '',   'Suffix appended to company name for party ledger (e.g. blank or GSTIN)'),
  ('tally_company_gstin',         '33AAACU4245J1ZF', 'Seller GSTIN — bridge refuses to post if Tally''s open company doesn''t match'),
  ('tally_voucher_series',        '',   'Tally voucher series for GST sales (e.g. "Sales")'),
  ('tally_sync_enabled',          'false', 'Master switch — set to true once bridge is live and tested'),
  ('tally_irn_alarm_hours',       '4',  'Alert if IRN is missing N hours after voucher was created in Tally')
ON CONFLICT (key) DO NOTHING;

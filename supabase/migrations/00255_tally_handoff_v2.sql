-- Migration: Tally Handoff v2 — schema only
--
-- Companion to docs/tally-handoff-redesign.md (PR #1).
-- Adds the schema needed for the human-mediated Tally handoff flow.
-- No behavior change: new columns are nullable, new tables are empty,
-- and the application gates everything behind the `tally_handoff_v2_enabled`
-- feature flag (added in a later PR).
--
-- Reversibility:
--   - All changes are additive. Down-migration would `DROP COLUMN` /
--     `DROP TABLE` cleanly. No existing data is rewritten.
--   - Existing in-flight statements keep `handoff_state = NULL` — they
--     stay on the old bridge-writer flow until manually migrated
--     (handled outside this PR, per user direction).

-- =============================================================================
-- 1. billing_statements: handoff_state (workflow state for the accounts inbox)
-- =============================================================================

ALTER TABLE billing_statements
  ADD COLUMN handoff_state text;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_handoff_state_check
  CHECK (handoff_state IS NULL OR handoff_state IN (
    'pi_awaiting_payment',
    'pi_paid_awaiting_gst',
    'direct_gst_requested',
    'name_check_pending',
    'ready_to_send',
    'gst_sent',
    'gst_sent_awaiting_payment',
    'paid_awaiting_receipt_record',
    'complete'
  ));

COMMENT ON COLUMN billing_statements.handoff_state IS
  'Accounts-inbox workflow state. Derived from lifecycle_stage + payment_status + issuance_channel + has_upload. NULL = legacy bridge-writer flow. See docs/tally-handoff-redesign.md §5.';

CREATE INDEX idx_billing_statements_handoff_state
  ON billing_statements (handoff_state)
  WHERE handoff_state IS NOT NULL AND handoff_state <> 'complete';
  -- Partial index: inbox queries only care about open items.

-- =============================================================================
-- 2. billing_statements: created_via (audit — cron vs ad-hoc request)
-- =============================================================================

ALTER TABLE billing_statements
  ADD COLUMN created_via text;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_created_via_check
  CHECK (created_via IS NULL OR created_via IN (
    'cron',              -- monthly billing cron
    'ad_hoc_request',    -- contract page "Request GST invoice" button
    'manual_correction', -- manual SQL or admin tool
    'legacy'             -- pre-handoff-v2
  ));

COMMENT ON COLUMN billing_statements.created_via IS
  'Audit: how this statement was created. NULL for rows that predate this column.';

-- =============================================================================
-- 3. gst_invoice_uploads — accountant uploads of Tally GST invoice PDFs
-- =============================================================================

CREATE TABLE gst_invoice_uploads (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id    uuid NOT NULL REFERENCES billing_statements(id) ON DELETE RESTRICT,
  uploaded_by             uuid NOT NULL REFERENCES auth.users(id),
  uploaded_at             timestamptz NOT NULL DEFAULT now(),

  -- Extracted / entered values
  tally_invoice_number    text NOT NULL,        -- e.g. SD/A/26-27/175 or SD/B/26-27/89
  tally_invoice_series    text NOT NULL
                          CHECK (tally_invoice_series IN ('SDIPL-REG', 'SDIPL-UNREG')),
                          -- SDIPL-REG = A-series (IRN required, customer has GSTIN)
                          -- SDIPL-UNREG = B-series (no IRN, customer has no GSTIN)
  irn                     text,                 -- 64-char IRN — REQUIRED iff series=SDIPL-REG
  invoice_date            date NOT NULL,
  invoice_amount          numeric(12, 2) NOT NULL,

  -- Verification
  invoice_pdf_url         text NOT NULL,        -- B2 storage URL
  qr_payload              jsonb,                -- decoded JWT from QR if present
  autofill_source         text NOT NULL
                          CHECK (autofill_source IN ('qr', 'pdf_text', 'bridge_match', 'manual')),
  nic_signature_verified  boolean NOT NULL DEFAULT false,

  -- Name check (fuzzy match between contract name and Tally party name)
  name_check_status       text NOT NULL DEFAULT 'pending'
                          CHECK (name_check_status IN ('pending', 'approved', 'overridden')),
  name_check_decided_by   uuid REFERENCES auth.users(id),
  name_check_decided_at   timestamptz,
  name_check_notes        text,

  -- Audit chain (re-uploads supersede earlier uploads)
  superseded_by           uuid REFERENCES gst_invoice_uploads(id),
  notes                   text,

  -- Compliance: A-series ⟺ IRN present, B-series ⟺ IRN null.
  -- This is the database-level guard for the §15 Q5 decision.
  CONSTRAINT gst_invoice_uploads_irn_matches_series CHECK (
    (tally_invoice_series = 'SDIPL-REG'   AND irn IS NOT NULL AND length(irn) = 64) OR
    (tally_invoice_series = 'SDIPL-UNREG' AND irn IS NULL)
  ),

  -- Sanity: amount must be positive.
  CONSTRAINT gst_invoice_uploads_amount_positive CHECK (invoice_amount > 0)
);

CREATE INDEX idx_gst_uploads_statement
  ON gst_invoice_uploads (billing_statement_id);

CREATE INDEX idx_gst_uploads_irn
  ON gst_invoice_uploads (irn)
  WHERE irn IS NOT NULL;

CREATE INDEX idx_gst_uploads_invoice_number
  ON gst_invoice_uploads (tally_invoice_number);

CREATE INDEX idx_gst_uploads_uploaded_at
  ON gst_invoice_uploads (uploaded_at DESC);

-- RLS
ALTER TABLE gst_invoice_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gst_uploads_select_accounts_admin"
  ON gst_invoice_uploads
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('accounts', 'admin', 'office_admin', 'manager')
    )
  );

CREATE POLICY "gst_uploads_insert_accounts_admin"
  ON gst_invoice_uploads
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('accounts', 'admin')
    )
  );

CREATE POLICY "gst_uploads_update_accounts_admin"
  ON gst_invoice_uploads
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('accounts', 'admin')
    )
  );

-- No DELETE policy — uploads are audit records, supersede via superseded_by instead.

COMMENT ON TABLE gst_invoice_uploads IS
  'One row per accountant upload of a Tally GST invoice PDF. See docs/tally-handoff-redesign.md §6A.';

-- =============================================================================
-- 4. tally_voucher_snapshots — read-only mirror from the bridge
-- =============================================================================

CREATE TABLE tally_voucher_snapshots (
  voucher_master_id       text NOT NULL,        -- Tally's REMOTEID
  company_name            text NOT NULL,        -- guard against wrong-company sync
  voucher_kind            text NOT NULL
                          CHECK (voucher_kind IN ('sales', 'receipt', 'credit_note')),
  voucher_series          text,                 -- SDIPL-REG | SDIPL-UNREG | CREDIT NOTE-REG | Receipt
  invoice_number          text,                 -- voucher number, e.g. SD/A/26-27/175
  party_name              text,
  party_gstin             text,
  voucher_date            date,
  voucher_amount          numeric(12, 2),
  irn                     text,
  against_voucher         text,                 -- for receipts: the sales voucher this receipt clears
  custom_fields           jsonb NOT NULL DEFAULT '{}'::jsonb,
                          -- narration, cost center, voucher class, dispatch info, etc.

  -- Linkage to CRM (best-effort match, computed by /api/tally/sync-pull)
  matched_statement_id    uuid REFERENCES billing_statements(id),
  match_confidence        text CHECK (match_confidence IN ('exact', 'probable', 'unmatched')),

  -- Sync metadata
  last_synced_at          timestamptz NOT NULL DEFAULT now(),
  sync_batch_id           uuid NOT NULL,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (voucher_master_id, company_name)
);

CREATE INDEX idx_voucher_snapshots_invoice_number
  ON tally_voucher_snapshots (invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE INDEX idx_voucher_snapshots_statement
  ON tally_voucher_snapshots (matched_statement_id)
  WHERE matched_statement_id IS NOT NULL;

CREATE INDEX idx_voucher_snapshots_irn
  ON tally_voucher_snapshots (irn)
  WHERE irn IS NOT NULL;

CREATE INDEX idx_voucher_snapshots_against
  ON tally_voucher_snapshots (against_voucher)
  WHERE against_voucher IS NOT NULL;

CREATE INDEX idx_voucher_snapshots_last_synced
  ON tally_voucher_snapshots (last_synced_at DESC);

-- RLS
ALTER TABLE tally_voucher_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voucher_snapshots_select_accounts_admin"
  ON tally_voucher_snapshots
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('accounts', 'admin', 'office_admin', 'manager')
    )
  );

-- No INSERT/UPDATE/DELETE policies for `authenticated`. Only the service role
-- (used by the bridge POST /api/tally/sync-pull endpoint) may write here.

COMMENT ON TABLE tally_voucher_snapshots IS
  'Read-only mirror of Tally vouchers, populated by the bridge POSTing to /api/tally/sync-pull. The bridge never writes to Tally; this table never writes back to Tally. See docs/tally-handoff-redesign.md §6B and §9.';

-- =============================================================================
-- 5. Feature flag entry — disabled until PR #2 lands
-- =============================================================================

INSERT INTO app_settings (key, value)
VALUES (
  'tally_handoff_v2_enabled',
  'false'
)
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- End of migration. Behavior is unchanged until PR #2 reads handoff_state and
-- the feature flag is enabled.
-- =============================================================================

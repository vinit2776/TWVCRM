-- Migration: Tally-era billing Phase 1
--
-- Surgical change: GST invoice GENERATION moves to Tally. PI flow + per-contract
-- billing_mode (proforma_first/gst_direct) are untouched.
--
-- Adds to billing_statements:
--   issuance_channel  — who issues the GST invoice for THIS statement: 'crm' (default,
--                       existing behaviour) or 'tally'. Stamped ONCE at the GST-generation
--                       moment (decide-once, D2) so a mid-run switch flip never splits a
--                       statement's steps between CRM and Tally.
--   tally_delivered_at — when dispatchTallyInvoice delivered the invoice + link to the
--                       customer. NULL = not delivered. Drives delivered-once gate (D3)
--                       and the reminder predicate (OV1 — never dun an undelivered invoice).
--   lifecycle_stage   — single stamped stage so the page + crons read the same field
--                       instead of deriving from 6 columns (OV7).

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS issuance_channel TEXT NOT NULL DEFAULT 'crm'
    CONSTRAINT billing_statements_issuance_channel_check
      CHECK (issuance_channel IN ('crm', 'tally')),
  ADD COLUMN IF NOT EXISTS tally_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT
    CONSTRAINT billing_statements_lifecycle_stage_check
      CHECK (lifecycle_stage IS NULL OR lifecycle_stage IN (
        'queued',         -- Tally job enqueued, voucher not yet created
        'issuing',        -- bridge claimed it
        'awaiting_irn',   -- B2B voucher created, IRN pending
        'issued',         -- invoice number (+ IRN) present, not yet delivered
        'sent',           -- delivered to customer
        'failed'          -- Tally/ledger/IRP error
      ));

-- All existing statements default to issuance_channel='crm' — current behaviour, untouched.

-- Fast lookup for the undelivered-sweep cron: tally invoices issued but not delivered.
CREATE INDEX IF NOT EXISTS billing_statements_tally_undelivered_idx
  ON billing_statements (tally_synced_at)
  WHERE issuance_channel = 'tally'
    AND tally_invoice_number IS NOT NULL
    AND tally_delivered_at IS NULL;

-- Fast lookup for the reconciliation sweep: tally jobs stuck posted/in-progress.
-- (tally_sync_jobs already indexed on status in 00235.)

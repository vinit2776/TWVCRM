-- Tally-era cancel via Credit Note (Phase 1b).
--
-- A Tally-issued GST invoice cannot be CRM-voided (it's on Tally's books). To cancel
-- it, the CRM enqueues a credit_note job; the bridge posts a Credit Note in Tally
-- reversing the invoice; on confirmation the CRM marks the statement voided. This
-- adds the two lifecycle stages for that flow + columns to record the Tally credit note.

-- Extend lifecycle_stage with the cancel states. Recreate the CHECK constraint
-- (00238 defined it) to include 'cancelling' and 'cancelled'.
ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_lifecycle_stage_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_lifecycle_stage_check
    CHECK (lifecycle_stage IS NULL OR lifecycle_stage IN (
      'queued',         -- Tally job enqueued, voucher not yet created
      'issuing',        -- bridge claimed it
      'awaiting_irn',   -- B2B voucher created, IRN pending
      'issued',         -- invoice number (+ IRN) present, not yet delivered
      'sent',           -- delivered to customer
      'cancelling',     -- credit-note job enqueued, Tally not yet confirmed
      'cancelled',      -- Tally credit note posted; statement voided
      'failed'          -- Tally/ledger/IRP error
    ));

-- Record the Tally credit note that reversed this invoice (mirrored back on ack).
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS tally_credit_note_number TEXT,
  ADD COLUMN IF NOT EXISTS tally_credit_note_guid   TEXT;

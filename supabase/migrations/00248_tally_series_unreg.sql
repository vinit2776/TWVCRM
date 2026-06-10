-- Migration: Tally Series B (UNREG) voucher type settings
--
-- Adds app_settings keys for non-GST (B2C) invoice series so the
-- /api/tally/pending route can route each job to the correct Tally
-- voucher type based on whether the customer has a GSTIN:
--
--   GST-registered  (leads.gst_number IS NOT NULL) → tally_voucher_series     (SDIPL-REG)
--   Non-GST / B2C   (leads.gst_number IS NULL)     → tally_voucher_series_unreg (SDIPL-UNREG)
--
-- The same split applies to credit notes.
-- tally_credit_note_series is backfilled here (was used in code but never seeded).

INSERT INTO app_settings (key, value) VALUES
  ('tally_voucher_series_unreg',    'SDIPL-UNREG'),
  ('tally_credit_note_series',      'CREDIT NOTE-REG'),
  ('tally_credit_note_series_unreg','CREDIT NOTE-UNREG')
ON CONFLICT (key) DO NOTHING;

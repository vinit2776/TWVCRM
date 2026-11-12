-- Tracks the most recent watermark-free "Download for signature" copy
-- generated for a contract before its start_date is confirmed (locked).
-- Lets the UI warn staff if start_date changes after that copy went out
-- for physical signature, since the signed copy would then be stale.

ALTER TABLE contracts
  ADD COLUMN signature_copy_generated_at TIMESTAMPTZ,
  ADD COLUMN signature_copy_start_date DATE;

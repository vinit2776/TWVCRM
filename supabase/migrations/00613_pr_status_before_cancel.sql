-- ============================================================
-- Migration 00613: remember what a cancelled MR was before it was cancelled
--
-- An MR can be cancelled from draft or submitted. The admin "Reopen cancelled
-- MR" rollback returns it to exactly that status; older cancelled MRs, with no
-- record, go back to draft. Additive, nullable.
-- ============================================================

ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS status_before_cancel TEXT DEFAULT NULL;

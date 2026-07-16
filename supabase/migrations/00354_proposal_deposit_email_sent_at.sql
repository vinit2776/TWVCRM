-- ============================================================
-- Migration 00354: Proposal deposit email sent timestamp
--
-- Tracks when the security deposit email was last sent to the
-- customer, so the Security Deposit card can show "Last sent" and
-- staff can tell whether/when a reminder actually went out.
-- ============================================================

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_email_sent_at TIMESTAMPTZ;

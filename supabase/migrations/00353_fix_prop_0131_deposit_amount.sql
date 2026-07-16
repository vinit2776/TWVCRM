-- ============================================================
-- Migration 00353: Fix PROP-0131 security_deposit_amount
--
-- One-off data correction. Before migration 00352 (deposit credit
-- ledger) existed, security_deposit_amount on PROP-0131 was
-- mistakenly overwritten from the true required deposit (₹39,600 —
-- 2 months x ₹19,800 rent) down to ₹16,600 (the balance after
-- netting a ₹23,000 deposit held from the customer's prior
-- terminated contract). That was the wrong mechanism — it destroyed
-- the required-deposit history with no audit record.
--
-- This restores the required deposit to its true value. The ₹23,000
-- credit is applied separately via the deposit_credit_* columns
-- (00352) / POST /api/proposals/[id]/deposit-credit, which preserves
-- both numbers and records proof + reason for audit.
-- ============================================================

UPDATE proposals
  SET security_deposit_amount = 39600
  WHERE proposal_number = 'PROP-0131';

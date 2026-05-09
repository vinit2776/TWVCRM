-- Fix contract end dates: subtract 1 day from all existing records.
--
-- Root cause: the contract creation and renewal routes calculated
--   end_date = start_date + tenure_months
-- which yields the *first day of month N+1*, not the *last day of month N*.
-- e.g. Nov 1 2025 + 11 months = Oct 1 2026 (wrong) → Sep 30 2026 (correct).
--
-- The application code has been fixed going forward. This migration corrects
-- all historical rows in a single idempotent pass.
--
-- Safe to run on all statuses (draft, sent, viewed, accepted, active,
-- renewed, expired, terminated) — the end_date on a terminated/expired
-- contract is still used for display and reporting.

UPDATE contracts
SET end_date = end_date - INTERVAL '1 day'
WHERE end_date IS NOT NULL;

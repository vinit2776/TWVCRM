-- =====================================================================
-- Migration 00183: Fix stale total_estimated_amount on purchase_requests
-- =====================================================================
-- Problem: Some PRs have total_estimated_amount = 0 at the PR level even
-- though their purchase_request_items rows carry correct estimated_price /
-- total_estimated values. This happens when items were priced after the
-- initial PR creation (e.g. direct DB edits, backfill migrations) without
-- the PR-level aggregate being refreshed.
--
-- Fix: Re-derive total_estimated_amount from the sum of item total_estimated
-- for every PR where the stored value is 0 but at least one item has a
-- non-null, positive total_estimated.
--
-- Safe to re-run: the WHERE guards ensure rows that legitimately have 0
-- (no priced items at all) are left alone.

UPDATE purchase_requests pr
SET total_estimated_amount = (
  SELECT COALESCE(SUM(COALESCE(pri.total_estimated, 0)), 0)
  FROM purchase_request_items pri
  WHERE pri.pr_id = pr.id
)
WHERE pr.total_estimated_amount = 0
  AND EXISTS (
    SELECT 1
    FROM purchase_request_items pri2
    WHERE pri2.pr_id = pr.id
      AND pri2.total_estimated IS NOT NULL
      AND pri2.total_estimated > 0
  );

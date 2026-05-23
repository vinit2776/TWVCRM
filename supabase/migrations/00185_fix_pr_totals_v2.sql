-- =====================================================================
-- Migration 00185: Re-fix total_estimated_amount after 00184 reset it
-- =====================================================================
-- Root cause: Step 4 in migrations 00182 and 00184 used an unqualified
-- `id` in the correlated subquery WHERE clause. PostgreSQL resolves this
-- to purchase_request_items.id (the inner table) rather than the outer
-- purchase_requests.id, so SUM always returns 0.
--
-- Migration 00183 already had the correct pattern (alias pr, use pr.id).
-- We reuse that same approach here to re-derive the total for any PR
-- where the stored total is 0 but items have priced lines (including
-- PR-2605-079 whose total was reset to 0 by the buggy Step 4 in 00184).

UPDATE purchase_requests pr
SET total_estimated_amount = (
  SELECT COALESCE(SUM(COALESCE(pri.total_estimated, 0)), 0)
  FROM purchase_request_items pri
  WHERE pri.pr_id = pr.id          -- explicit alias: resolves to purchase_requests.id
)
WHERE pr.total_estimated_amount = 0
  AND EXISTS (
    SELECT 1
    FROM purchase_request_items pri2
    WHERE pri2.pr_id = pr.id
      AND pri2.total_estimated IS NOT NULL
      AND pri2.total_estimated > 0
  );

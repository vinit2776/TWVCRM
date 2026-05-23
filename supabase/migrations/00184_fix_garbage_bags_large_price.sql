-- =====================================================================
-- Migration 00184: Set price for "Garbage Bags Large" on PR-2605-079
-- =====================================================================
-- Catalogue item has standard_price = null (and is inactive).
-- Unit price manually confirmed as ₹70 by admin.
-- Mirrors the same 4-step chain fix used in migration 00182.

-- ── Step 1: Set estimated_price on the PR line item ──────────────────
UPDATE purchase_request_items
SET
  estimated_price = 70,
  total_estimated = ROUND((70 * quantity)::numeric, 2)
FROM purchase_requests pr
WHERE pr_id           = pr.id
  AND pr.pr_number    = 'PR-2605-079'
  AND item_name       ILIKE '%Garbage Bags Large%'
  AND estimated_price IS NULL;

-- ── Step 2: Set unit_price on the linked PO line item ────────────────
UPDATE purchase_order_items
SET
  unit_price   = 70,
  total_amount = ROUND((70 * quantity_ordered)::numeric, 2),
  gst_amount   = ROUND((70 * quantity_ordered * COALESCE(gst_rate, 0) / 100)::numeric, 2)
FROM purchase_request_items pri,
     purchase_requests pr
WHERE pr_item_id       = pri.id
  AND pri.pr_id        = pr.id
  AND pr.pr_number     = 'PR-2605-079'
  AND pri.item_name    ILIKE '%Garbage Bags Large%'
  AND unit_price       IS NULL;

-- ── Step 3: Recalculate PO-level totals ──────────────────────────────
UPDATE purchase_orders
SET
  total_ordered_amount  = agg.base,
  total_gst_amount      = agg.gst,
  total_amount_with_gst = agg.base + agg.gst
FROM (
  SELECT
    poi.po_id,
    COALESCE(SUM(COALESCE(poi.unit_price, 0) * poi.quantity_ordered), 0) AS base,
    COALESCE(SUM(COALESCE(poi.gst_amount, 0)), 0)                        AS gst
  FROM purchase_order_items poi
  WHERE poi.po_id IN (
    SELECT DISTINCT poi2.po_id
    FROM purchase_order_items poi2
    JOIN purchase_request_items pri ON pri.id = poi2.pr_item_id
    JOIN purchase_requests pr       ON pr.id  = pri.pr_id
    WHERE pr.pr_number = 'PR-2605-079'
  )
  GROUP BY poi.po_id
) agg
WHERE id = agg.po_id;

-- ── Step 4: Recalculate PR total_estimated_amount ────────────────────
UPDATE purchase_requests
SET total_estimated_amount = (
  SELECT COALESCE(SUM(COALESCE(pri.total_estimated, 0)), 0)
  FROM purchase_request_items pri
  WHERE pri.pr_id = id
)
WHERE pr_number = 'PR-2605-079';

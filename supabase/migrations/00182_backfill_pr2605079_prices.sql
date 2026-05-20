-- =====================================================================
-- Migration 00182: Backfill missing prices for PR-2605-079
-- =====================================================================
-- Context: PR-2605-079 "Garbage Extra Large" has estimated_price = NULL
-- in purchase_request_items, and the linked PO line items also have
-- unit_price = NULL. The catalogue's standard_price is now set; this
-- migration copies it down the chain.
--
-- Technique: PostgreSQL UPDATE...FROM requires the target table to NOT
-- appear in the FROM clause. Use comma-separated FROM (implicit cross-join
-- filtered by WHERE) so unqualified column references resolve to the
-- target table. Explicit JOINs that reference the target table again
-- cause "invalid reference" errors.

-- ── Step 1: Backfill purchase_request_items ──────────────────────────────────
UPDATE purchase_request_items
SET
  estimated_price = pi.standard_price,
  total_estimated = ROUND((pi.standard_price * quantity)::numeric, 2)
FROM purchase_requests pr,
     procurement_items pi
WHERE pr_id            = pr.id
  AND item_id          = pi.id
  AND pr.pr_number     = 'PR-2605-079'
  AND item_name        ILIKE '%Garbage Extra Large%'
  AND pi.standard_price IS NOT NULL
  AND estimated_price   IS NULL;

-- ── Step 2: Backfill purchase_order_items ────────────────────────────────────
UPDATE purchase_order_items
SET
  unit_price   = pri.estimated_price,
  total_amount = ROUND(
    (pri.estimated_price * quantity_ordered)::numeric, 2
  ),
  gst_amount   = ROUND(
    (pri.estimated_price * quantity_ordered * COALESCE(gst_rate, 0) / 100)::numeric, 2
  )
FROM purchase_request_items pri,
     purchase_requests pr
WHERE pr_item_id       = pri.id
  AND pri.pr_id        = pr.id
  AND pr.pr_number     = 'PR-2605-079'
  AND pri.item_name    ILIKE '%Garbage Extra Large%'
  AND pri.estimated_price IS NOT NULL
  AND unit_price        IS NULL;

-- ── Step 3: Recalculate PO-level totals for every PO touched above ───────────
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

-- ── Step 4: Recalculate PR total_estimated_amount ────────────────────────────
UPDATE purchase_requests
SET total_estimated_amount = (
  SELECT COALESCE(SUM(COALESCE(pri.total_estimated, 0)), 0)
  FROM purchase_request_items pri
  WHERE pri.pr_id = id
)
WHERE pr_number = 'PR-2605-079';

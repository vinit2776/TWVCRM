-- Visits used now counts only preventive and annual_service events. Breakdowns
-- are unlimited and remote support is a phone call, so they no longer use up a
-- covered visit. Contracts logged before this change counted every event.
--
-- Data-only: recomputes amc_visits_used from the logged events and clears an
-- "exhausted" status that was only reached because of uncounted visits.

UPDATE purchase_orders po
SET amc_visits_used = COALESCE(c.n, 0)
FROM (
  SELECT po2.id, COUNT(e.id) AS n
  FROM purchase_orders po2
  LEFT JOIN amc_service_events e
    ON e.po_id = po2.id
   AND e.event_type IN ('preventive', 'annual_service')
  WHERE po2.po_type = 'service'
  GROUP BY po2.id
) c
WHERE po.id = c.id
  AND po.po_type = 'service'
  AND po.amc_visits_used IS DISTINCT FROM COALESCE(c.n, 0);

-- An "exhausted" contract that is no longer over its visit limit goes back to
-- the status its dates imply (same order as the event route's status check).
UPDATE purchase_orders
SET amc_status = CASE
  WHEN amc_start_date IS NULL OR amc_start_date > CURRENT_DATE THEN 'inactive'
  WHEN amc_end_date IS NOT NULL AND amc_end_date < CURRENT_DATE THEN 'expired'
  WHEN amc_end_date IS NOT NULL AND (amc_end_date - CURRENT_DATE) <= 60 THEN 'expiring'
  ELSE 'active'
END
WHERE po_type = 'service'
  AND amc_status = 'exhausted'
  AND (amc_visits_covered IS NULL OR amc_visits_used < amc_visits_covered);
